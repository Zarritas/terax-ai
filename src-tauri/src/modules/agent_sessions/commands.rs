use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::modules::agent_sessions::provider::{binary_in_path, AgentProvider};
use crate::modules::agent_sessions::providers::all_providers;
use crate::modules::agent_sessions::types::{AgentProviderInfo, AgentSession, LiveAgentSession};

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
        list_sessions_inner(&state, force)
    })
    .await
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
                    resume_argv: Vec::new(),
                },
            ])
        }
        fn resume_argv(&self, session_id: &str) -> Vec<String> {
            vec!["fake".to_string(), session_id.to_string()]
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
