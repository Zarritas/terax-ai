pub mod claude;

use crate::modules::agent_sessions::provider::AgentProvider;

/// Every provider we know how to read, in display order.
pub fn all_providers() -> Vec<Box<dyn AgentProvider>> {
    vec![Box::new(claude::ClaudeProvider::new())]
}
