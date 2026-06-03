// Codex CLI session provider.
//
// Layout: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. The first
// line is a `session_meta` event carrying the session id and cwd; the first
// `event_msg`/`user_message` event carries the first real prompt. Archived
// sessions live under `~/.codex/archived_sessions` and are excluded (they are
// protected from resume until restored). Optional `~/.codex/session_index.jsonl`
// maps ids to user-given thread names (append-only, last entry wins).

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::modules::agent_sessions::provider::{AgentProvider, FileScanCache};
use crate::modules::agent_sessions::providers::claude::{strip_command_wrappers, truncate};
use crate::modules::agent_sessions::types::AgentSession;

const HEADER_SCAN_LINES: usize = 40;

pub struct CodexProvider {
    home: PathBuf,
    cache: FileScanCache,
}

impl CodexProvider {
    pub fn new() -> Self {
        Self {
            home: dirs::home_dir().unwrap_or_default().join(".codex"),
            cache: FileScanCache::default(),
        }
    }

    #[cfg(test)]
    pub fn with_home(home: PathBuf) -> Self {
        Self {
            home,
            cache: FileScanCache::default(),
        }
    }

    fn sessions_dir(&self) -> PathBuf {
        self.home.join("sessions")
    }
}

impl Default for CodexProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentProvider for CodexProvider {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn display_name(&self) -> &'static str {
        "Codex"
    }

    fn binary(&self) -> &'static str {
        "codex"
    }

    fn detect(&self) -> bool {
        self.sessions_dir().is_dir()
    }

    fn list_sessions(&self) -> Result<Vec<AgentSession>, String> {
        let names = load_session_names(&self.home.join("session_index.jsonl"));
        let mut sessions = Vec::new();
        for rollout in collect_rollouts(&self.sessions_dir()) {
            let Some(mtime) = mtime_secs(&rollout) else {
                continue;
            };
            let Some(mut session) = self
                .cache
                .get_or_build(&rollout, mtime, || build_session(&rollout))
            else {
                continue;
            };
            // Thread names live in the index, not the rollout: stamp fresh so
            // a rename is reflected without invalidating the cached parse.
            if let Some(name) = names.get(&session.id) {
                session.title = Some(name.clone());
            }
            sessions.push(session);
        }
        self.cache.retain_existing();
        Ok(sessions)
    }

    fn resume_argv(&self, session_id: &str) -> Vec<String> {
        vec![
            "codex".to_string(),
            "resume".to_string(),
            session_id.to_string(),
        ]
    }
}

/// Walk `sessions/YYYY/MM/DD/` collecting `rollout-*.jsonl` files. The layout
/// is exactly three levels deep, so a bounded manual walk avoids a recursion
/// dependency.
fn collect_rollouts(sessions_dir: &Path) -> Vec<PathBuf> {
    let mut rollouts = Vec::new();
    let years = read_subdirs(sessions_dir);
    for year in years {
        for month in read_subdirs(&year) {
            for day in read_subdirs(&month) {
                let Ok(entries) = std::fs::read_dir(&day) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                        rollouts.push(path);
                    }
                }
            }
        }
    }
    rollouts
}

fn read_subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect()
}

/// Parse the append-only `session_index.jsonl` ({id, thread_name, updated_at});
/// later entries win. Missing file → empty map (older codex versions).
fn load_session_names(index_path: &Path) -> HashMap<String, String> {
    let mut names = HashMap::new();
    let Ok(file) = File::open(index_path) else {
        return names;
    };
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let (Some(id), Some(name)) = (
            entry.get("id").and_then(Value::as_str),
            entry.get("thread_name").and_then(Value::as_str),
        ) else {
            continue;
        };
        if !name.is_empty() {
            names.insert(id.to_string(), name.to_string());
        }
    }
    names
}

fn build_session(rollout: &Path) -> Option<AgentSession> {
    let meta = std::fs::metadata(rollout).ok()?;
    let file = File::open(rollout).ok()?;
    let mut reader = BufReader::new(file).lines();

    // First line must be the session_meta event; anything else isn't a rollout.
    let first = reader.next()?.ok()?;
    let head = serde_json::from_str::<Value>(&first).ok()?;
    if head.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = head.get("payload")?;
    let id = payload.get("id").and_then(Value::as_str)?.to_string();
    let cwd = payload
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string);

    let mut first_prompt = None;
    for line in reader.take(HEADER_SCAN_LINES) {
        let Ok(line) = line else { break };
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        let Some(payload) = event.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(Value::as_str) != Some("user_message") {
            continue;
        }
        if let Some(message) = payload.get("message").and_then(Value::as_str) {
            first_prompt = Some(truncate(&strip_command_wrappers(message)));
            break;
        }
    }

    Some(AgentSession {
        provider: "codex".to_string(),
        id,
        title: first_prompt,
        cwd,
        branch: None,
        message_count: None,
        size_bytes: Some(meta.len()),
        last_activity: mtime_secs(rollout).unwrap_or(0.0),
        is_active: false,
        resume_argv: Vec::new(),
    })
}

fn mtime_secs(path: &Path) -> Option<f64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(
        modified
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs_f64(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_rollout(home: &Path, id: &str, prompt: Option<&str>) -> PathBuf {
        let day = home.join("sessions/2026/06/03");
        std::fs::create_dir_all(&day).unwrap();
        let mut lines = vec![format!(
            "{{\"timestamp\":\"2026-06-03T10:00:00.000Z\",\"type\":\"session_meta\",\
             \"payload\":{{\"id\":\"{id}\",\"cwd\":\"/work/proj\",\"originator\":\"codex_cli\"}}}}"
        )];
        lines.push("{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}".to_string());
        if let Some(p) = prompt {
            lines.push(format!(
                "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\
                 \"message\":\"{p}\"}}}}"
            ));
        }
        let path = day.join(format!("rollout-2026-06-03T10-00-00-{id}.jsonl"));
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        path
    }

    #[test]
    fn lists_rollouts_with_meta_and_prompt() {
        let tmp = tempfile::tempdir().unwrap();
        write_rollout(tmp.path(), "0199-aaaa", Some("arregla el parser"));
        let provider = CodexProvider::with_home(tmp.path().to_path_buf());
        let sessions = provider.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.id, "0199-aaaa");
        assert_eq!(s.cwd.as_deref(), Some("/work/proj"));
        assert_eq!(s.title.as_deref(), Some("arregla el parser"));
        assert_eq!(s.provider, "codex");
    }

    #[test]
    fn session_index_name_wins_over_prompt() {
        let tmp = tempfile::tempdir().unwrap();
        write_rollout(tmp.path(), "0199-bbbb", Some("prompt"));
        std::fs::write(
            tmp.path().join("session_index.jsonl"),
            "{\"id\":\"0199-bbbb\",\"thread_name\":\"viejo\",\"updated_at\":1}\n\
             {\"id\":\"0199-bbbb\",\"thread_name\":\"mi refactor\",\"updated_at\":2}\n",
        )
        .unwrap();
        let provider = CodexProvider::with_home(tmp.path().to_path_buf());
        let sessions = provider.list_sessions().unwrap();
        assert_eq!(sessions[0].title.as_deref(), Some("mi refactor"));
    }

    #[test]
    fn archived_sessions_are_excluded() {
        let tmp = tempfile::tempdir().unwrap();
        write_rollout(tmp.path(), "0199-cccc", None);
        // Same shape under archived_sessions must not be picked up.
        let archived_day = tmp.path().join("archived_sessions/2026/06/03");
        std::fs::create_dir_all(&archived_day).unwrap();
        std::fs::write(
            archived_day.join("rollout-2026-06-03T09-00-00-0199-dddd.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"0199-dddd\",\"cwd\":\"/x\"}}\n",
        )
        .unwrap();
        let provider = CodexProvider::with_home(tmp.path().to_path_buf());
        let ids: Vec<String> = provider
            .list_sessions()
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["0199-cccc"]);
    }

    #[test]
    fn non_rollout_files_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let day = tmp.path().join("sessions/2026/06/03");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(day.join("notes.jsonl"), "{}\n").unwrap();
        std::fs::write(day.join("rollout-bad.jsonl"), "{\"type\":\"other\"}\n").unwrap();
        let provider = CodexProvider::with_home(tmp.path().to_path_buf());
        assert!(provider.list_sessions().unwrap().is_empty());
    }

    #[test]
    fn resume_argv_shape() {
        let p = CodexProvider::new();
        assert_eq!(p.resume_argv("abc"), vec!["codex", "resume", "abc"]);
    }
}
