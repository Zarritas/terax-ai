use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    /// Provider id: "claude" | "codex" | "opencode" | "gemini".
    pub provider: String,
    /// The id the provider's own CLI accepts in its resume command.
    pub id: String,
    /// Best available label: explicit rename/title, else first prompt.
    pub title: Option<String>,
    /// Working directory to resume under. None when the provider can't recover it.
    pub cwd: Option<String>,
    pub branch: Option<String>,
    /// None when the provider doesn't track it (or counting was capped).
    pub message_count: Option<u32>,
    pub size_bytes: Option<u64>,
    /// Unix seconds of the last activity (file mtime).
    pub last_activity: f64,
    /// True when the provider's live registry reports the session as running.
    /// Only Claude Code persists such a registry today.
    pub is_active: bool,
    /// Argv the frontend writes into a new terminal to resume this session.
    /// Filled centrally from `AgentProvider::resume_argv` so the command
    /// surface stays in one place; providers construct it empty.
    pub resume_argv: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderInfo {
    pub id: String,
    pub display_name: String,
    /// The provider's data directory exists (it has been used on this machine).
    pub available: bool,
    /// The provider's binary is resolvable in PATH (resume will work).
    pub binary_found: bool,
    /// Argv the frontend writes into a new terminal to start a fresh session.
    pub new_session_argv: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LiveAgentSession {
    pub provider: String,
    pub session_id: String,
    pub pid: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTurn {
    /// "user" | "assistant"
    pub role: String,
    pub text: String,
}
