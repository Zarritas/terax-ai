// Discover and describe coding-agent CLI sessions persisted on disk (Claude Code,
// Codex, OpenCode, Gemini), so the Agent Sessions panel can list and resume them.
//
// Read-only by design: providers derive every path from the home directory and
// never accept paths from the frontend.

pub mod commands;
pub mod extract;
pub mod fts;
pub mod live;
pub mod provider;
pub mod providers;
pub mod service_status;
pub mod transfer;
pub mod types;
