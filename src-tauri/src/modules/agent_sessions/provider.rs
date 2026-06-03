use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::modules::agent_sessions::types::{
    AgentSession, DeleteError, LiveAgentSession, PreviewTurn,
};

/// One coding-agent CLI whose on-disk sessions we know how to read.
///
/// Implementations are read-only and derive every path from the home directory;
/// nothing here accepts paths from the frontend.
pub trait AgentProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    /// Name of the executable used to resume sessions (looked up in PATH).
    fn binary(&self) -> &'static str;
    /// The provider's data directory exists on this machine.
    fn detect(&self) -> bool;
    /// Every known session, unsorted; callers sort/group.
    fn list_sessions(&self) -> Result<Vec<AgentSession>, String>;
    /// Sessions the provider reports as currently running. Most providers
    /// keep no such registry and return the default empty vec.
    fn live_sessions(&self) -> Vec<LiveAgentSession> {
        Vec::new()
    }
    /// Argv to resume `session_id` (e.g. `["claude", "--resume", id]`).
    fn resume_argv(&self, session_id: &str) -> Vec<String>;
    /// Absolute path of the on-disk artefact backing `session_id`, if this
    /// provider stores one. None for providers without per-session files
    /// (opencode) or when the session isn't found.
    fn locate(&self, _session_id: &str) -> Option<PathBuf> {
        None
    }
    /// Last conversation turns for a preview. Err("unsupported") for
    /// providers whose content isn't readable from disk (opencode).
    fn preview(&self, _session_id: &str) -> Result<Vec<PreviewTurn>, String> {
        Err("unsupported".to_string())
    }
    /// Concatenated user+assistant text for the FTS index, capped. None when
    /// unsupported or the session can't be found.
    fn fts_content(&self, _session_id: &str) -> Option<String> {
        None
    }
    /// Delete every on-disk artefact for `session_id`. Idempotent: an
    /// already-absent session is success. `force` bypasses the live-session
    /// guard (only claude keeps a live registry). Deliberately has no default
    /// so every provider spells out its destructive flow.
    fn delete_session(&self, session_id: &str, force: bool) -> Result<(), DeleteError>;
    /// Drop any internal result caches so the next scan is fully fresh.
    /// Called on user-initiated refresh; mtime-keyed file caches don't need
    /// it (they self-invalidate), so the default is a no-op.
    fn invalidate_caches(&self) {}
    /// Argv to start a fresh session (usually just the binary).
    fn new_session_argv(&self) -> Vec<String> {
        vec![self.binary().to_string()]
    }
}

/// Per-file scan cache keyed by mtime. Session logs are append-only and big
/// (a real ~/.claude tops 100 MB); re-parsing only files whose mtime moved
/// turns the steady-state scan into a stat() walk.
///
/// Cached sessions are stored provider-shaped but *neutral*: `is_active`
/// false and `resume_argv` empty — both are stamped per call by the consumer.
#[derive(Default)]
pub struct FileScanCache {
    entries: Mutex<HashMap<PathBuf, (f64, AgentSession)>>,
}

impl FileScanCache {
    /// Return the cached session for `path` when `mtime` matches; otherwise
    /// run `build`, cache its result, and return it.
    pub fn get_or_build(
        &self,
        path: &Path,
        mtime: f64,
        build: impl FnOnce() -> Option<AgentSession>,
    ) -> Option<AgentSession> {
        if let Ok(entries) = self.entries.lock() {
            if let Some((cached_mtime, session)) = entries.get(path) {
                if *cached_mtime == mtime {
                    return Some(session.clone());
                }
            }
        }
        let session = build()?;
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(path.to_path_buf(), (mtime, session.clone()));
        }
        Some(session)
    }

    /// Drop entries whose file no longer exists (deleted sessions).
    pub fn retain_existing(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|path, _| path.exists());
        }
    }
}

/// Resolve `name` against PATH like the shell would, including Windows
/// extensions (`.exe`, `.cmd`, `.bat`) since agent CLIs ship as npm shims there.
pub fn binary_in_path(name: &str) -> bool {
    let Some(paths) = env::var_os("PATH") else {
        return false;
    };
    let candidates: Vec<String> = if cfg!(windows) {
        ["", ".exe", ".cmd", ".bat"]
            .iter()
            .map(|ext| format!("{name}{ext}"))
            .collect()
    } else {
        vec![name.to_string()]
    };
    env::split_paths(&paths).any(|dir| {
        candidates.iter().any(|c| {
            let full: PathBuf = dir.join(c);
            full.is_file()
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_in_path_finds_sh_on_unix() {
        #[cfg(unix)]
        assert!(binary_in_path("sh"));
    }

    #[test]
    fn binary_in_path_rejects_nonexistent() {
        assert!(!binary_in_path("definitely-not-a-real-binary-xyz"));
    }

    fn dummy_session(title: &str) -> AgentSession {
        AgentSession {
            provider: "claude".to_string(),
            id: "x".to_string(),
            title: Some(title.to_string()),
            cwd: None,
            branch: None,
            message_count: None,
            size_bytes: None,
            last_activity: 0.0,
            is_active: false,
            resume_argv: Vec::new(),
        }
    }

    #[test]
    fn file_cache_hits_on_same_mtime_and_rebuilds_on_change() {
        let cache = FileScanCache::default();
        let path = Path::new("/fake/session.jsonl");
        let mut builds = 0;
        for _ in 0..3 {
            let s = cache.get_or_build(path, 100.0, || {
                builds += 1;
                Some(dummy_session("v1"))
            });
            assert_eq!(s.unwrap().title.as_deref(), Some("v1"));
        }
        assert_eq!(builds, 1, "same mtime must reuse the cached entry");

        let s = cache.get_or_build(path, 200.0, || Some(dummy_session("v2")));
        assert_eq!(s.unwrap().title.as_deref(), Some("v2"));
    }

    #[test]
    fn file_cache_failed_build_is_not_cached() {
        let cache = FileScanCache::default();
        let path = Path::new("/fake/broken.jsonl");
        assert!(cache.get_or_build(path, 1.0, || None).is_none());
        // A later successful build must still run.
        let s = cache.get_or_build(path, 1.0, || Some(dummy_session("ok")));
        assert!(s.is_some());
    }
}
