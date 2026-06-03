use std::env;
use std::path::PathBuf;

use crate::modules::agent_sessions::types::{AgentSession, LiveAgentSession};

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
    /// Argv to start a fresh session (usually just the binary).
    fn new_session_argv(&self) -> Vec<String> {
        vec![self.binary().to_string()]
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
}
