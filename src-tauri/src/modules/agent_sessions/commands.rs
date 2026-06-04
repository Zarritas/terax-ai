use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::modules::agent_sessions::fts::FtsIndex;
use crate::modules::agent_sessions::provider::{binary_in_path, resolve_binary, AgentProvider};
use crate::modules::agent_sessions::providers::all_providers;
use crate::modules::agent_sessions::providers::claude::encode_cwd;
use crate::modules::agent_sessions::service_status::ServiceStatusCache;
use crate::modules::agent_sessions::transfer::{
    self, ExportItem, ImportOutcome, ManifestSessionInfo,
};
use crate::modules::agent_sessions::types::{
    AgentProviderInfo, AgentSession, LiveAgentSession, PreviewTurn, ProviderQuota, ServiceStatus,
    SessionRef,
};

/// Repeated UI refetches (watcher debounce, window focus) within this window
/// reuse the last scan instead of re-walking every provider.
const CACHE_TTL: Duration = Duration::from_secs(3);

/// Providers live for the process lifetime so their internal caches (per-file
/// mtime caches, OpenCode's TTL result cache) actually persist between calls.
pub struct AgentSessionsState {
    providers: Vec<Box<dyn AgentProvider>>,
    cache: Mutex<Option<(Instant, Vec<AgentSession>)>>,
    /// Single-flight guard: panel mount, window focus and a watcher event can
    /// land together; without this they all miss the TTL at once and scan in
    /// parallel (observed: 3x an 11s cold scan). Held across the scan so
    /// latecomers wait and then hit the freshly written cache.
    scan_lock: Mutex<()>,
    /// Lazy FTS index handle: needs the AppHandle path resolver, so it can't
    /// be built in Default. Failed means we tried and gave up (search
    /// degrades to empty, the panel itself keeps working).
    fts: Mutex<FtsState>,
    /// Single-flight for the indexing pass: concurrent list commands would
    /// otherwise both see stale mtimes and read the same files twice
    /// (observed as two overlapping "fts indexed" passes per scan burst).
    index_lock: Mutex<()>,
    /// Hosted-service health, cached for a few minutes.
    service_status: ServiceStatusCache,
}

enum FtsState {
    Uninitialized,
    Ready(std::sync::Arc<FtsIndex>),
    Failed,
}

impl Default for AgentSessionsState {
    fn default() -> Self {
        Self::with_providers(all_providers())
    }
}

impl AgentSessionsState {
    fn with_providers(providers: Vec<Box<dyn AgentProvider>>) -> Self {
        Self {
            providers,
            cache: Mutex::new(None),
            scan_lock: Mutex::new(()),
            fts: Mutex::new(FtsState::Uninitialized),
            index_lock: Mutex::new(()),
            service_status: ServiceStatusCache::default(),
        }
    }

    /// Open (once) and return the FTS index. None when it failed to open.
    fn fts(&self, app: &AppHandle) -> Option<std::sync::Arc<FtsIndex>> {
        let mut slot = self.fts.lock().ok()?;
        match &*slot {
            FtsState::Ready(idx) => return Some(idx.clone()),
            FtsState::Failed => return None,
            FtsState::Uninitialized => {}
        }
        let opened = app
            .path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())
            .and_then(|dir| FtsIndex::open(&dir.join("agent-sessions-index.sqlite3")));
        match opened {
            Ok(idx) => {
                let idx = std::sync::Arc::new(idx);
                *slot = FtsState::Ready(idx.clone());
                Some(idx)
            }
            Err(err) => {
                log::warn!("agent_sessions: fts index unavailable: {err}");
                *slot = FtsState::Failed;
                None
            }
        }
    }
}

/// Cache lookup honoring `max_age`.
fn cached_sessions(
    state: &AgentSessionsState,
    max_age: Duration,
) -> Result<Option<Vec<AgentSession>>, String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    Ok(cache
        .as_ref()
        .and_then(|(at, sessions)| (at.elapsed() < max_age).then(|| sessions.clone())))
}

/// TTL cache + single-flight around the actual provider walk. `force` skips
/// the fast path but still reuses a scan that *finished while we waited* for
/// the lock — forcing means "don't serve stale", not "repeat fresh work".
fn list_sessions_inner(
    state: &AgentSessionsState,
    force: bool,
) -> Result<Vec<AgentSession>, String> {
    if !force {
        if let Some(sessions) = cached_sessions(state, CACHE_TTL)? {
            return Ok(sessions);
        }
    }
    let _guard = state.scan_lock.lock().map_err(|e| e.to_string())?;
    if let Some(sessions) = cached_sessions(state, CACHE_TTL)? {
        return Ok(sessions);
    }
    if force {
        // User-initiated refresh: drop provider result caches (OpenCode's
        // long TTL) so the walk below is fully fresh.
        for provider in &state.providers {
            provider.invalidate_caches();
        }
    }
    let sessions = scan_all_sessions(&state.providers);
    let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
    *cache = Some((Instant::now(), sessions.clone()));
    Ok(sessions)
}

async fn blocking<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_providers(app: AppHandle) -> Result<Vec<AgentProviderInfo>, String> {
    blocking(move || {
        let state = app.state::<AgentSessionsState>();
        Ok(state
            .providers
            .iter()
            .map(|p| AgentProviderInfo {
                id: p.id().to_string(),
                display_name: p.display_name().to_string(),
                available: p.detect(),
                binary_found: binary_in_path(p.binary()),
                new_session_argv: p.new_session_argv(),
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn agent_list_sessions(
    force: Option<bool>,
    app: AppHandle,
) -> Result<Vec<AgentSession>, String> {
    let force = force.unwrap_or(false);
    blocking(move || {
        let state = app.state::<AgentSessionsState>();
        let sessions = list_sessions_inner(&state, force)?;
        if let Some(fts) = state.fts(&app) {
            // Serialize indexing: latecomers see fresh mtimes and no-op.
            let _guard = state.index_lock.lock().map_err(|e| e.to_string())?;
            index_changed_sessions(&state.providers, &fts, &sessions);
        }
        Ok(sessions)
    })
    .await
}

#[tauri::command]
pub async fn agent_delete_session(
    provider: String,
    session_id: String,
    force: Option<bool>,
    app: AppHandle,
) -> Result<(), String> {
    let force = force.unwrap_or(false);
    blocking(move || {
        let state = app.state::<AgentSessionsState>();
        let p = state
            .providers
            .iter()
            .find(|p| p.id() == provider)
            .ok_or_else(|| format!("unknown provider {provider}"))?;
        // Serialize against scans so we never delete under a walk in flight.
        let _guard = state.scan_lock.lock().map_err(|e| e.to_string())?;
        p.delete_session(&session_id, force)
            .map_err(|e| e.to_user_string())?;
        if let Some(fts) = state.fts(&app) {
            fts.delete(&provider, &session_id);
        }
        let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
        *cache = None;
        Ok(())
    })
    .await
}

/// Compaction is an LLM summarization pass over the whole session — big logs
/// take minutes, not seconds.
const COMPACT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

#[tauri::command]
pub async fn agent_compact_session(
    provider: String,
    session_id: String,
    cwd: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<AgentSessionsState>();
        let p = state
            .providers
            .iter()
            .find(|p| p.id() == provider)
            .ok_or_else(|| format!("unknown provider {provider}"))?;
        // Two processes over one session log would race; a live session
        // compacts from its own terminal instead.
        if p.live_sessions()
            .iter()
            .any(|l| l.session_id == session_id)
        {
            return Err("ACTIVE".to_string());
        }
        let argv = p
            .compact_argv(&session_id)
            .ok_or_else(|| "UNSUPPORTED".to_string())?;
        // No scan_lock here: the run takes minutes and scans are read-only —
        // holding it would freeze every panel refresh until compaction ends.
        run_to_completion(&argv, cwd.as_deref(), COMPACT_TIMEOUT)?;
        let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
        *cache = None;
        Ok(())
    })
    .await
}

/// Run `argv` headless under `cwd` (falling back to home when it's gone) and
/// wait for it with a hard timeout; on timeout the child is killed. Stderr is
/// drained on a helper thread so a chatty CLI can't deadlock the pipe.
fn run_to_completion(
    argv: &[String],
    cwd: Option<&str>,
    timeout: std::time::Duration,
) -> Result<(), String> {
    use std::io::Read;

    let (bin, args) = argv.split_first().ok_or("empty argv")?;
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let workdir = cwd
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or(home);
    let mut cmd = std::process::Command::new(
        resolve_binary(bin).unwrap_or_else(|| std::path::PathBuf::from(bin)),
    );
    cmd.args(args)
        .current_dir(workdir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("{bin}: {e}"))?;

    let stderr = child.stderr.take();
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut err) = stderr {
            let _ = err.read_to_string(&mut buf);
        }
        let _ = tx.send(buf);
    });

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stderr = rx.recv().unwrap_or_default();
                let _ = reader.join();
                if status.success() {
                    return Ok(());
                }
                let detail = stderr.trim();
                return Err(if detail.is_empty() {
                    format!("{bin} exited with {status}")
                } else {
                    format!("{bin}: {detail}")
                });
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = reader.join();
                    return Err(format!("{bin} timed out after {}s", timeout.as_secs()));
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

#[tauri::command]
pub async fn agent_session_preview(
    provider: String,
    session_id: String,
    app: AppHandle,
) -> Result<Vec<PreviewTurn>, String> {
    blocking(move || {
        let state = app.state::<AgentSessionsState>();
        let p = state
            .providers
            .iter()
            .find(|p| p.id() == provider)
            .ok_or_else(|| format!("unknown provider {provider}"))?;
        p.preview(&session_id)
    })
    .await
}

#[tauri::command]
pub async fn agent_search_sessions(
    query: String,
    app: AppHandle,
) -> Result<Vec<SessionRef>, String> {
    blocking(move || {
        let state = app.state::<AgentSessionsState>();
        Ok(state
            .fts(&app)
            .map(|fts| fts.search(&query, 200))
            .unwrap_or_default())
    })
    .await
}

fn claude_provider(state: &AgentSessionsState) -> Result<&dyn AgentProvider, String> {
    state
        .providers
        .iter()
        .map(|p| p.as_ref())
        .find(|p| p.id() == "claude")
        .ok_or_else(|| "claude provider unavailable".to_string())
}

fn claude_projects_dir() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".claude")
        .join("projects")
}

#[tauri::command]
pub async fn agent_export_sessions(
    items: Vec<ExportItem>,
    dest_path: String,
    app: AppHandle,
) -> Result<usize, String> {
    blocking(move || {
        let state = app.state::<AgentSessionsState>();
        let claude = claude_provider(&state)?;
        let sessions = list_sessions_inner(&state, false)?;
        let entries: Vec<_> = items
            .into_iter()
            .filter_map(|item| {
                sessions
                    .iter()
                    .find(|s| s.provider == "claude" && s.id == item.session_id)
                    .map(|s| (s.clone(), item))
            })
            .collect();
        transfer::export_sessions(
            &entries,
            |id| claude.locate(id),
            std::path::Path::new(&dest_path),
        )
    })
    .await
}

#[tauri::command]
pub async fn agent_read_manifest(zip_path: String) -> Result<Vec<ManifestSessionInfo>, String> {
    blocking(move || transfer::read_manifest(std::path::Path::new(&zip_path))).await
}

#[tauri::command]
pub async fn agent_import_sessions(
    zip_path: String,
    dest_cwd: String,
    app: AppHandle,
) -> Result<ImportOutcome, String> {
    blocking(move || {
        let state = app.state::<AgentSessionsState>();
        let dest_dir = claude_projects_dir().join(encode_cwd(&dest_cwd));
        // Imports target existing projects only: Claude resumes sessions under
        // a cwd it has already encoded a dir for.
        if !dest_dir.is_dir() {
            return Err(format!("no existing Claude project for {dest_cwd}"));
        }
        let _guard = state.scan_lock.lock().map_err(|e| e.to_string())?;
        let outcome = transfer::import_archive(std::path::Path::new(&zip_path), &dest_dir)?;
        let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
        *cache = None;
        Ok(outcome)
    })
    .await
}

#[tauri::command]
pub async fn agent_move_session(
    session_id: String,
    source_cwd: String,
    dest_cwd: String,
    app: AppHandle,
) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<AgentSessionsState>();
        let claude = claude_provider(&state)?;
        let live: std::collections::HashSet<String> = claude
            .live_sessions()
            .into_iter()
            .map(|l| l.session_id)
            .collect();
        let _guard = state.scan_lock.lock().map_err(|e| e.to_string())?;
        transfer::move_session(
            &claude_projects_dir(),
            &session_id,
            &encode_cwd(&source_cwd),
            &encode_cwd(&dest_cwd),
            |id| live.contains(id),
        )?;
        let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
        *cache = None;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn agent_service_status(app: AppHandle) -> Result<Vec<ServiceStatus>, String> {
    blocking(move || {
        let state = app.state::<AgentSessionsState>();
        Ok(state.service_status.get())
    })
    .await
}

#[tauri::command]
pub async fn agent_quotas(app: AppHandle) -> Result<Vec<ProviderQuota>, String> {
    blocking(move || {
        let state = app.state::<AgentSessionsState>();
        Ok(state
            .providers
            .iter()
            .filter(|p| p.detect())
            .filter_map(|p| p.quota())
            .collect())
    })
    .await
}

/// Reindex sessions whose file mtime moved since the last indexing pass.
/// Providers without readable content (fts_content -> None) are stamped with
/// empty text so they aren't re-read on every scan.
fn index_changed_sessions(
    providers: &[Box<dyn AgentProvider>],
    fts: &FtsIndex,
    sessions: &[AgentSession],
) {
    let started = Instant::now();
    let mut indexed = 0usize;
    for session in sessions {
        if session.provider == "opencode" {
            continue; // content lives in opencode's own database
        }
        if !fts.needs_reindex(&session.provider, &session.id, session.last_activity) {
            continue;
        }
        let Some(provider) = providers.iter().find(|p| p.id() == session.provider) else {
            continue;
        };
        let content = provider.fts_content(&session.id).unwrap_or_default();
        fts.upsert(
            &session.provider,
            &session.id,
            session.last_activity,
            &content,
        );
        indexed += 1;
    }
    if indexed > 0 {
        log::info!(
            "agent_sessions: fts indexed {indexed} sessions in {}ms",
            started.elapsed().as_millis()
        );
    }
}

#[tauri::command]
pub async fn agent_live_sessions(app: AppHandle) -> Result<Vec<LiveAgentSession>, String> {
    blocking(move || {
        let state = app.state::<AgentSessionsState>();
        Ok(state
            .providers
            .iter()
            .filter(|p| p.detect())
            .flat_map(|p| p.live_sessions())
            .collect())
    })
    .await
}

/// Scan every detected provider; a single failing provider degrades to a log
/// line instead of taking the whole panel down. Per-provider wall time is
/// logged so load regressions show up in the app log (`agent_sessions:` lines).
fn scan_all_sessions(providers: &[Box<dyn AgentProvider>]) -> Vec<AgentSession> {
    let total = Instant::now();
    let mut out = Vec::new();
    for provider in providers {
        if !provider.detect() {
            continue;
        }
        let started = Instant::now();
        match provider.list_sessions() {
            Ok(sessions) => {
                log::info!(
                    "agent_sessions: {} scanned {} sessions in {}ms",
                    provider.id(),
                    sessions.len(),
                    started.elapsed().as_millis()
                );
                for mut session in sessions {
                    session.resume_argv = provider.resume_argv(&session.id);
                    out.push(session);
                }
            }
            Err(err) => log::warn!(
                "agent_sessions: {} scan failed after {}ms: {err}",
                provider.id(),
                started.elapsed().as_millis()
            ),
        }
    }
    // Newest first; the frontend groups but relies on this base order.
    out.sort_by(|a, b| b.last_activity.total_cmp(&a.last_activity));
    log::info!(
        "agent_sessions: full scan {} sessions in {}ms",
        out.len(),
        total.elapsed().as_millis()
    );
    out
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    /// Counts scans and sleeps a bit so concurrent callers genuinely overlap.
    /// Keeps tests off the real HOME (and away from spawning opencode).
    struct FakeProvider {
        scans: Arc<AtomicUsize>,
    }

    impl AgentProvider for FakeProvider {
        fn id(&self) -> &'static str {
            "fake"
        }
        fn display_name(&self) -> &'static str {
            "Fake"
        }
        fn binary(&self) -> &'static str {
            "fake"
        }
        fn detect(&self) -> bool {
            true
        }
        fn list_sessions(&self) -> Result<Vec<AgentSession>, String> {
            self.scans.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(50));
            Ok(vec![
                AgentSession {
                    provider: "fake".to_string(),
                    id: "old".to_string(),
                    title: None,
                    cwd: None,
                    branch: None,
                    message_count: None,
                    size_bytes: None,
                    last_activity: 100.0,
                    is_active: false,
                    context_tokens: None,
                    context_window: None,
                    model: None,
                    started_at: None,
                    cost_usd: None,
                    live_status: None,
                    resume_argv: Vec::new(),
                },
                AgentSession {
                    provider: "fake".to_string(),
                    id: "new".to_string(),
                    title: None,
                    cwd: None,
                    branch: None,
                    message_count: None,
                    size_bytes: None,
                    last_activity: 200.0,
                    is_active: false,
                    context_tokens: None,
                    context_window: None,
                    model: None,
                    started_at: None,
                    cost_usd: None,
                    live_status: None,
                    resume_argv: Vec::new(),
                },
            ])
        }
        fn resume_argv(&self, session_id: &str) -> Vec<String> {
            vec!["fake".to_string(), session_id.to_string()]
        }
        fn delete_session(
            &self,
            _session_id: &str,
            _force: bool,
        ) -> Result<(), crate::modules::agent_sessions::types::DeleteError> {
            Ok(())
        }
        fn fts_content(&self, session_id: &str) -> Option<String> {
            Some(format!("contenido de {session_id}"))
        }
    }

    fn fake_state(scans: &Arc<AtomicUsize>) -> AgentSessionsState {
        AgentSessionsState::with_providers(vec![Box::new(FakeProvider {
            scans: scans.clone(),
        })])
    }

    #[test]
    fn concurrent_forced_calls_share_one_scan() {
        // Panel mount + window focus + watcher can force at the same time;
        // the single-flight lock must collapse them into exactly one walk.
        let scans = Arc::new(AtomicUsize::new(0));
        let state = Arc::new(fake_state(&scans));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let state = state.clone();
            handles.push(std::thread::spawn(move || {
                list_sessions_inner(&state, true).unwrap()
            }));
        }
        for handle in handles {
            let sessions = handle.join().unwrap();
            assert_eq!(sessions.len(), 2);
        }
        assert_eq!(scans.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn ttl_cache_serves_repeat_calls_without_rescan() {
        let scans = Arc::new(AtomicUsize::new(0));
        let state = fake_state(&scans);
        for _ in 0..3 {
            list_sessions_inner(&state, false).unwrap();
        }
        assert_eq!(scans.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn indexing_is_incremental_by_mtime() {
        let scans = Arc::new(AtomicUsize::new(0));
        let state = fake_state(&scans);
        let fts = FtsIndex::open_in_memory().unwrap();
        let sessions = list_sessions_inner(&state, true).unwrap();

        index_changed_sessions(&state.providers, &fts, &sessions);
        assert_eq!(fts.search("contenido", 10).len(), 2);
        // Same mtimes: a second pass must not rewrite anything (search keeps
        // working and needs_reindex is false for every session).
        index_changed_sessions(&state.providers, &fts, &sessions);
        for s in &sessions {
            assert!(!fts.needs_reindex(&s.provider, &s.id, s.last_activity));
        }
    }

    #[test]
    fn scan_sorts_newest_first_and_stamps_resume_argv() {
        let scans = Arc::new(AtomicUsize::new(0));
        let state = fake_state(&scans);
        let sessions = list_sessions_inner(&state, true).unwrap();
        assert_eq!(
            sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["new", "old"]
        );
        assert_eq!(sessions[0].resume_argv, vec!["fake", "new"]);
    }
}
