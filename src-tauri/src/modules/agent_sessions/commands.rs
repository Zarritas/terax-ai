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
}

impl Default for AgentSessionsState {
    fn default() -> Self {
        Self {
            providers: all_providers(),
            cache: Mutex::new(None),
        }
    }
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
        if !force {
            let cache = state.cache.lock().map_err(|e| e.to_string())?;
            if let Some((at, sessions)) = cache.as_ref() {
                if at.elapsed() < CACHE_TTL {
                    return Ok(sessions.clone());
                }
            }
        }
        let sessions = scan_all_sessions(&state.providers);
        let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
        *cache = Some((Instant::now(), sessions.clone()));
        Ok(sessions)
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
    use super::*;

    #[test]
    fn scan_all_sessions_sorts_newest_first() {
        // Providers read real dirs; with none detected in a sandboxed HOME the
        // sort contract still holds on the empty vec. The per-provider logic
        // is covered by each provider's own tests.
        let providers = all_providers();
        let sessions = scan_all_sessions(&providers);
        let mut sorted = sessions.clone();
        sorted.sort_by(|a, b| b.last_activity.total_cmp(&a.last_activity));
        assert_eq!(
            sessions.iter().map(|s| &s.id).collect::<Vec<_>>(),
            sorted.iter().map(|s| &s.id).collect::<Vec<_>>()
        );
    }
}
