// Claude Code session provider.
//
// Layout: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, one event per
// line. The dir name is the session cwd with every non-alphanumeric char
// replaced by `-`, so it can't be decoded losslessly — the real cwd is read
// back from the sessions' own `cwd` events, preferring the candidate whose
// re-encoding matches the dir name (sessions moved across cwds record a stale
// first cwd and would otherwise flip the project identity).

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::modules::agent_sessions::live;
use crate::modules::agent_sessions::provider::AgentProvider;
use crate::modules::agent_sessions::types::{AgentSession, LiveAgentSession};

const HEADER_SCAN_LINES: usize = 80;
const PROMPT_MAX_CHARS: usize = 120;
/// Cap when scanning long sessions for the latest `/rename`.
const RENAME_SCAN_LINES: usize = 50_000;
/// Files larger than this skip the exact line count (message_count = None)
/// rather than stalling a scan on a runaway session log.
const LINE_COUNT_MAX_BYTES: u64 = 50 * 1024 * 1024;

pub struct ClaudeProvider {
    home: PathBuf,
}

impl ClaudeProvider {
    pub fn new() -> Self {
        Self {
            home: dirs::home_dir().unwrap_or_default().join(".claude"),
        }
    }

    #[cfg(test)]
    pub fn with_home(home: PathBuf) -> Self {
        Self { home }
    }

    fn projects_dir(&self) -> PathBuf {
        self.home.join("projects")
    }
}

impl Default for ClaudeProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentProvider for ClaudeProvider {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn display_name(&self) -> &'static str {
        "Claude Code"
    }

    fn binary(&self) -> &'static str {
        "claude"
    }

    fn detect(&self) -> bool {
        self.projects_dir().is_dir()
    }

    fn list_sessions(&self) -> Result<Vec<AgentSession>, String> {
        let projects = self.projects_dir();
        let Ok(entries) = std::fs::read_dir(&projects) else {
            return Ok(Vec::new());
        };
        let active: HashSet<String> = self
            .live_sessions()
            .into_iter()
            .map(|l| l.session_id)
            .collect();
        let mut sessions = Vec::new();
        for entry in entries.flatten() {
            let project_dir = entry.path();
            if !project_dir.is_dir() {
                continue;
            }
            let jsonl_files = jsonl_files_newest_first(&project_dir);
            if jsonl_files.is_empty() {
                continue;
            }
            let project_cwd = resolve_real_cwd(&project_dir, &jsonl_files);
            for jsonl in &jsonl_files {
                let Some(session) = build_session(jsonl, project_cwd.as_deref(), &active) else {
                    continue;
                };
                sessions.push(session);
            }
        }
        Ok(sessions)
    }

    fn live_sessions(&self) -> Vec<LiveAgentSession> {
        live::claude_live_sessions(&self.home)
    }

    fn resume_argv(&self, session_id: &str) -> Vec<String> {
        vec![
            "claude".to_string(),
            "--resume".to_string(),
            session_id.to_string(),
        ]
    }
}

fn jsonl_files_newest_first(project_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(project_dir) else {
        return Vec::new();
    };
    let mut files: Vec<(f64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().is_none_or(|ext| ext != "jsonl") {
                return None;
            }
            let mtime = mtime_secs(&path)?;
            Some((mtime, path))
        })
        .collect();
    files.sort_by(|a, b| b.0.total_cmp(&a.0));
    files.into_iter().map(|(_, p)| p).collect()
}

fn build_session(
    jsonl: &Path,
    project_cwd: Option<&str>,
    active: &HashSet<String>,
) -> Option<AgentSession> {
    let id = jsonl.file_stem()?.to_string_lossy().to_string();
    let meta = std::fs::metadata(jsonl).ok()?;
    let header = parse_session_header(jsonl);
    let message_count = if meta.len() <= LINE_COUNT_MAX_BYTES {
        count_lines(jsonl).map(|n| n as u32)
    } else {
        None
    };
    let embedded_name = extract_embedded_name(jsonl);
    let title = embedded_name
        .or(header.display_name)
        .or(header.first_prompt);
    Some(AgentSession {
        provider: "claude".to_string(),
        is_active: active.contains(&id),
        id,
        title,
        // Resume must run under the cwd the project dir was named after;
        // the session's own header cwd is only a fallback.
        cwd: project_cwd.map(str::to_string).or(header.cwd),
        branch: header.branch,
        message_count,
        size_bytes: Some(meta.len()),
        last_activity: mtime_secs(jsonl).unwrap_or(0.0),
    })
}

/// Replicate Claude Code's project-dir encoding: every non-alphanumeric → '-'.
pub fn encode_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Resolve the project's real cwd from its sessions' `cwd` events, newest
/// first, preferring the candidate whose encoding matches the dir name.
fn resolve_real_cwd(project_dir: &Path, jsonl_newest_first: &[PathBuf]) -> Option<String> {
    let dir_name = project_dir.file_name()?.to_string_lossy();
    let mut fallback: Option<String> = None;
    for jsonl in jsonl_newest_first {
        let Some(cwd) = first_cwd(jsonl) else {
            continue;
        };
        if fallback.is_none() {
            fallback = Some(cwd.clone());
        }
        if encode_cwd(&cwd) == dir_name {
            return Some(cwd);
        }
    }
    fallback
}

fn first_cwd(jsonl: &Path) -> Option<String> {
    let file = File::open(jsonl).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(HEADER_SCAN_LINES) {
        let Ok(line) = line else { break };
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(cwd) = event.get("cwd").and_then(Value::as_str) {
            if !cwd.is_empty() {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

#[derive(Default)]
struct SessionHeader {
    first_prompt: Option<String>,
    cwd: Option<String>,
    branch: Option<String>,
    display_name: Option<String>,
}

fn parse_session_header(jsonl: &Path) -> SessionHeader {
    let mut header = SessionHeader::default();
    let Ok(file) = File::open(jsonl) else {
        return header;
    };
    let reader = BufReader::new(file);
    for line in reader.lines().take(HEADER_SCAN_LINES) {
        let Ok(line) = line else { break };
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if header.cwd.is_none() {
            header.cwd = non_empty_str(event.get("cwd"));
        }
        if header.branch.is_none() {
            header.branch = non_empty_str(event.get("gitBranch"));
        }
        if header.display_name.is_none() {
            header.display_name = non_empty_str(event.get("name"));
        }
        if header.first_prompt.is_none() {
            if let Some(prompt) = extract_user_prompt(&event) {
                header.first_prompt = Some(truncate(&strip_command_wrappers(&prompt)));
            }
        }
        if header.first_prompt.is_some()
            && header.cwd.is_some()
            && header.branch.is_some()
            && header.display_name.is_some()
        {
            break;
        }
    }
    header
}

fn non_empty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// If this event is a user message with text content, return that content.
fn extract_user_prompt(event: &Value) -> Option<String> {
    if event.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let message = event.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let content = message.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    // Some user messages come as a list of blocks; pick the first text block.
    for block in content.as_array()? {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                return Some(text.to_string());
            }
        }
    }
    None
}

/// Return the latest name set via Claude's `/rename`, scanning up to
/// RENAME_SCAN_LINES events for `system/local_command` stdout markers (later
/// renames win); also accepts a deprecated top-level `name` string.
fn extract_embedded_name(jsonl: &Path) -> Option<String> {
    const MARKER: &str = "Session renamed to:";
    let file = File::open(jsonl).ok()?;
    let reader = BufReader::new(file);
    let mut latest: Option<String> = None;
    for line in reader.lines().take(RENAME_SCAN_LINES) {
        let Ok(line) = line else { break };
        // Cheap pre-filter: full JSON parse only for candidate lines.
        let has_marker = line.contains(MARKER);
        let has_name = line.contains("\"name\"");
        if !has_marker && !has_name {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(top_name) = event.get("name").and_then(Value::as_str) {
            let trimmed = top_name.trim();
            if !trimmed.is_empty() {
                latest = Some(trimmed.to_string());
                continue;
            }
        }
        if !has_marker
            || event.get("type").and_then(Value::as_str) != Some("system")
            || event.get("subtype").and_then(Value::as_str) != Some("local_command")
        {
            continue;
        }
        let Some(content) = event.get("content").and_then(Value::as_str) else {
            continue;
        };
        if let Some(name) = parse_rename_stdout(content) {
            latest = Some(name);
        }
    }
    latest
}

/// Extract X from `<local-command-stdout>Session renamed to: X</local-command-stdout>`.
fn parse_rename_stdout(content: &str) -> Option<String> {
    let open = content.find("<local-command-stdout>")?;
    let rest = &content[open + "<local-command-stdout>".len()..];
    let close = rest.find("</local-command-stdout>")?;
    let inner = rest[..close].trim();
    let name = inner.strip_prefix("Session renamed to:")?.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Convert slash-command wrappers into a human-friendly summary:
/// `<command-name>/x</command-name><command-args>y</command-args>` → `/x y`.
/// Plain prompts pass through with inline `<tag>...</tag>` blocks stripped.
pub fn strip_command_wrappers(text: &str) -> String {
    if let Some(name) = extract_tag(text, "command-name") {
        let args = extract_tag(text, "command-args").unwrap_or_default();
        return format!("{} {}", name.trim(), args.trim())
            .trim()
            .to_string();
    }
    strip_inline_tags(text).trim().to_string()
}

fn extract_tag(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].to_string())
}

/// Remove every `<tag>...</tag>` block (non-nested, like the Python regex).
fn strip_inline_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open_at) = rest.find('<') {
        let Some(name_end) = rest[open_at..].find('>') else {
            break;
        };
        let tag_name = &rest[open_at + 1..open_at + name_end];
        if tag_name.is_empty() || tag_name.starts_with('/') || tag_name.contains('<') {
            out.push_str(&rest[..open_at + 1]);
            rest = &rest[open_at + 1..];
            continue;
        }
        let close = format!("</{tag_name}>");
        let Some(close_at) = rest[open_at..].find(&close) else {
            out.push_str(&rest[..open_at + 1]);
            rest = &rest[open_at + 1..];
            continue;
        };
        out.push_str(&rest[..open_at]);
        rest = &rest[open_at + close_at + close.len()..];
    }
    out.push_str(rest);
    out
}

/// Collapse whitespace and cap at PROMPT_MAX_CHARS (char-safe, with ellipsis).
pub fn truncate(text: &str) -> String {
    let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= PROMPT_MAX_CHARS {
        return collapsed;
    }
    let cut: String = collapsed.chars().take(PROMPT_MAX_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

/// Streaming newline count, 64 KB chunks, no full file in memory.
pub fn count_lines(path: &Path) -> Option<u64> {
    let mut file = File::open(path).ok()?;
    let mut buf = [0u8; 64 * 1024];
    let mut count: u64 = 0;
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        count += buf[..n].iter().filter(|&&b| b == b'\n').count() as u64;
    }
    Some(count)
}

fn mtime_secs(path: &Path) -> Option<f64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(dur.as_secs_f64())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_session(dir: &Path, id: &str, lines: &[&str]) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(format!("{id}.jsonl"));
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        path
    }

    fn user_event(cwd: &str, prompt: &str) -> String {
        format!(
            "{{\"type\":\"user\",\"cwd\":\"{cwd}\",\"gitBranch\":\"main\",\
             \"message\":{{\"role\":\"user\",\"content\":\"{prompt}\"}}}}"
        )
    }

    #[test]
    fn encode_cwd_replaces_non_alphanumerics() {
        assert_eq!(encode_cwd("/home/me/WS/repo"), "-home-me-WS-repo");
        assert_eq!(encode_cwd("/a/b.c_d"), "-a-b-c-d");
    }

    #[test]
    fn strip_command_wrappers_summarizes_slash_commands() {
        let text = "<command-message>refine</command-message>\
                    <command-name>/refine-task</command-name>\
                    <command-args>https://x</command-args>";
        assert_eq!(strip_command_wrappers(text), "/refine-task https://x");
    }

    #[test]
    fn strip_command_wrappers_passes_plain_text_and_strips_tags() {
        assert_eq!(strip_command_wrappers("hola mundo"), "hola mundo");
        assert_eq!(
            strip_command_wrappers("antes <system-hint>x</system-hint> después"),
            "antes  después"
        );
    }

    #[test]
    fn truncate_collapses_whitespace_and_caps() {
        assert_eq!(truncate("a  b\n\nc"), "a b c");
        let long = "x".repeat(300);
        let out = truncate(&long);
        assert_eq!(out.chars().count(), PROMPT_MAX_CHARS);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn count_lines_counts_newlines() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("f.jsonl");
        std::fs::write(&path, "a\nb\nc\n").unwrap();
        assert_eq!(count_lines(&path), Some(3));
    }

    #[test]
    fn header_extracts_prompt_cwd_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_session(
            tmp.path(),
            "s1",
            &[
                "{\"type\":\"summary\"}",
                &user_event("/work/x", "arregla el bug"),
            ],
        );
        let header = parse_session_header(&path);
        assert_eq!(header.first_prompt.as_deref(), Some("arregla el bug"));
        assert_eq!(header.cwd.as_deref(), Some("/work/x"));
        assert_eq!(header.branch.as_deref(), Some("main"));
    }

    #[test]
    fn embedded_rename_latest_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let rename = |n: &str| {
            format!(
                "{{\"type\":\"system\",\"subtype\":\"local_command\",\"content\":\
                 \"<local-command-stdout>Session renamed to: {n}</local-command-stdout>\"}}"
            )
        };
        let path = write_session(
            tmp.path(),
            "s2",
            &[
                &user_event("/w", "p"),
                &rename("primero"),
                &rename("segundo"),
            ],
        );
        assert_eq!(extract_embedded_name(&path).as_deref(), Some("segundo"));
    }

    #[test]
    fn resolve_real_cwd_prefers_encode_match_over_newest() {
        let tmp = tempfile::tempdir().unwrap();
        // Project dir named after /work/sub, but the NEWEST session records a
        // stale parent cwd (moved/resumed session). The encode match must win.
        let project = tmp.path().join(encode_cwd("/work/sub"));
        let old = write_session(&project, "old", &[&user_event("/work/sub", "a")]);
        let newer = write_session(&project, "new", &[&user_event("/work", "b")]);
        let t = std::time::SystemTime::now();
        let ft_old = filetime::FileTime::from_system_time(t - std::time::Duration::from_secs(100));
        let ft_new = filetime::FileTime::from_system_time(t);
        filetime::set_file_mtime(&old, ft_old).unwrap();
        filetime::set_file_mtime(&newer, ft_new).unwrap();
        let files = jsonl_files_newest_first(&project);
        assert_eq!(
            resolve_real_cwd(&project, &files).as_deref(),
            Some("/work/sub")
        );
    }

    #[test]
    fn list_sessions_builds_full_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join(".claude");
        let project = home.join("projects").join(encode_cwd("/work/proj"));
        write_session(
            &project,
            "abc-123",
            &[
                &user_event("/work/proj", "implementa la feature"),
                "{\"type\":\"assistant\"}",
            ],
        );
        let provider = ClaudeProvider::with_home(home);
        let sessions = provider.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.provider, "claude");
        assert_eq!(s.id, "abc-123");
        assert_eq!(s.title.as_deref(), Some("implementa la feature"));
        assert_eq!(s.cwd.as_deref(), Some("/work/proj"));
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.message_count, Some(2));
        assert!(!s.is_active);
    }

    #[test]
    fn resume_argv_shape() {
        let p = ClaudeProvider::new();
        assert_eq!(p.resume_argv("xyz"), vec!["claude", "--resume", "xyz"]);
        assert_eq!(p.new_session_argv(), vec!["claude"]);
    }
}
