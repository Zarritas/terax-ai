// Type-only import: erased at compile time, so pure helpers (and their
// vitest suite) never load the tauri API module at runtime.
import type { AgentSession } from "./native";

export type ProjectGroup = {
  /** Absolute path shared by the sessions, or null for unknown cwds. */
  cwd: string | null;
  /** Last path segment, or a placeholder for unknown cwds. */
  name: string;
  sessions: AgentSession[];
  lastActivity: number;
};

/** Visible label for a session row: title, else a trimmed id. */
export function sessionLabel(session: AgentSession): string {
  if (session.title?.trim()) return session.title;
  return session.id.length > 18 ? `${session.id.slice(0, 18)}…` : session.id;
}

/**
 * Case-insensitive match over label, cwd, branch and id. An empty query
 * matches everything.
 */
export function matchesFilter(session: AgentSession, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    session.title ?? "",
    session.cwd ?? "",
    session.branch ?? "",
    session.id,
  ]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((part) => haystack.includes(part));
}

/**
 * Group sessions by cwd, newest group first, sessions newest-first inside.
 * Unknown cwds collapse into a single trailing "(unknown)" group.
 */
export function groupByProject(sessions: AgentSession[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    const key = session.cwd ?? "";
    let group = groups.get(key);
    if (!group) {
      group = {
        cwd: session.cwd,
        name: session.cwd ? basename(session.cwd) : "(unknown location)",
        sessions: [],
        lastActivity: 0,
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
    group.lastActivity = Math.max(group.lastActivity, session.lastActivity);
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }
  list.sort((a, b) => {
    if (a.cwd === null) return 1;
    if (b.cwd === null) return -1;
    return b.lastActivity - a.lastActivity;
  });
  return list;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** "now", "5m", "3h", "2d", "4w" — compact, for narrow side-panel rows. */
export function formatRelativeTime(
  unixSecs: number,
  nowMs = Date.now(),
): string {
  const deltaSecs = Math.max(0, Math.floor(nowMs / 1000 - unixSecs));
  if (deltaSecs < 60) return "now";
  const mins = Math.floor(deltaSecs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return `${Math.floor(weeks / 52)}y`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
