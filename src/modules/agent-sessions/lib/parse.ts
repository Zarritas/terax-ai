// Type-only imports: erased at compile time, so pure helpers (and their
// vitest suite) never load the tauri API module at runtime.
import type { SessionMetadata } from "./metadata";
import type { AgentProviderId, AgentSession } from "./native";

export type ProjectGroup = {
  /** Absolute path shared by the sessions, or null for unknown cwds. */
  cwd: string | null;
  /** Last path segment, or a placeholder for unknown cwds. */
  name: string;
  sessions: AgentSession[];
  lastActivity: number;
};

/** Visible label for a session row: local rename > title > trimmed id. */
export function sessionLabel(
  session: AgentSession,
  meta?: SessionMetadata,
): string {
  if (meta?.name?.trim()) return meta.name;
  if (session.title?.trim()) return session.title;
  return session.id.length > 18 ? `${session.id.slice(0, 18)}…` : session.id;
}

export type ParsedFilter = {
  /** Terms behind `content:` — resolved asynchronously against the FTS index. */
  content: string | null;
  /** Structured predicates (tag:, branch:, id:, path:). */
  predicates: Array<{ key: "tag" | "branch" | "id" | "path"; value: string }>;
  /** Remaining free text, lowercased. */
  text: string;
};

const PREDICATE_KEYS = new Set(["tag", "branch", "id", "path", "content"]);

/** Split a filter query into content search, structured predicates and free
 * text. `content:` swallows the rest of the token only (terms are spaces). */
export function parseFilter(raw: string): ParsedFilter {
  const content: string[] = [];
  const predicates: ParsedFilter["predicates"] = [];
  const text: string[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    if (!token) continue;
    const colon = token.indexOf(":");
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
    if (!PREDICATE_KEYS.has(key)) {
      text.push(token.toLowerCase());
      continue;
    }
    const value = token.slice(colon + 1).toLowerCase();
    if (!value) continue;
    if (key === "content") content.push(value);
    else
      predicates.push({ key: key as "tag" | "branch" | "id" | "path", value });
  }
  return {
    content: content.length ? content.join(" ") : null,
    predicates,
    text: text.join(" "),
  };
}

/**
 * Case-insensitive match over label (including local rename), cwd, branch,
 * id and tags, plus the structured predicates. The `content:` part is
 * resolved by the caller against the FTS index.
 */
export function matchesFilter(
  session: AgentSession,
  filter: ParsedFilter,
  meta?: SessionMetadata,
): boolean {
  const tags = meta?.tags ?? [];
  for (const { key, value } of filter.predicates) {
    if (key === "tag") {
      const wanted = value.split(",").filter(Boolean);
      if (!wanted.every((w) => tags.some((t) => t.includes(w)))) return false;
    }
    if (
      key === "branch" &&
      !(session.branch ?? "").toLowerCase().includes(value)
    ) {
      return false;
    }
    if (key === "id" && !session.id.toLowerCase().includes(value)) return false;
    if (key === "path" && !(session.cwd ?? "").toLowerCase().includes(value)) {
      return false;
    }
  }
  if (!filter.text) return true;
  const haystack = [
    meta?.name ?? "",
    session.title ?? "",
    session.cwd ?? "",
    session.branch ?? "",
    session.id,
    tags.join(" "),
  ]
    .join(" ")
    .toLowerCase();
  return filter.text.split(/\s+/).every((part) => haystack.includes(part));
}

/** Manual per-session color palette: token persisted in metadata, classes
 * applied to the row accent bar and label. */
export const SESSION_COLORS: Array<{
  token: string;
  bar: string;
  label: string;
}> = [
  { token: "red", bar: "bg-red-500", label: "text-red-500" },
  { token: "orange", bar: "bg-orange-500", label: "text-orange-500" },
  { token: "amber", bar: "bg-amber-500", label: "text-amber-500" },
  { token: "emerald", bar: "bg-emerald-500", label: "text-emerald-500" },
  { token: "sky", bar: "bg-sky-500", label: "text-sky-500" },
  { token: "violet", bar: "bg-violet-500", label: "text-violet-500" },
  { token: "pink", bar: "bg-pink-500", label: "text-pink-500" },
  { token: "zinc", bar: "bg-zinc-500", label: "text-zinc-400" },
];

export function colorClasses(
  token?: string,
): { bar: string; label: string } | null {
  if (!token) return null;
  return SESSION_COLORS.find((c) => c.token === token) ?? null;
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

export type ProviderGroup = {
  provider: AgentProviderId;
  projects: ProjectGroup[];
  sessionCount: number;
  activeCount: number;
  lastActivity: number;
};

/** Stable section order, matching the backend's provider registry. */
const PROVIDER_ORDER: AgentProviderId[] = [
  "claude",
  "codex",
  "opencode",
  "gemini",
];

/**
 * Two-level grouping: provider sections in stable registry order (only those
 * with sessions), each holding its cwd project groups newest-first.
 */
export function groupByProviderThenProject(
  sessions: AgentSession[],
): ProviderGroup[] {
  const byProvider = new Map<AgentProviderId, AgentSession[]>();
  for (const session of sessions) {
    const list = byProvider.get(session.provider);
    if (list) list.push(session);
    else byProvider.set(session.provider, [session]);
  }
  const known = new Set<string>(PROVIDER_ORDER);
  const order: AgentProviderId[] = [
    ...PROVIDER_ORDER,
    // Future providers the frontend doesn't know yet still get a section.
    ...[...byProvider.keys()].filter((p) => !known.has(p)),
  ];
  const groups: ProviderGroup[] = [];
  for (const provider of order) {
    const list = byProvider.get(provider);
    if (!list?.length) continue;
    groups.push({
      provider,
      projects: groupByProject(list),
      sessionCount: list.length,
      activeCount: list.filter((s) => s.isActive).length,
      lastActivity: Math.max(...list.map((s) => s.lastActivity)),
    });
  }
  return groups;
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

/** Slug usable as a filename: word chars/dots/dashes kept, the rest folded
 * to single dashes, trimmed and capped (port of multi-claude's safe_filename). */
export function safeFilename(text: string, fallback = "session"): string {
  const cleaned = text
    .trim()
    .replace(/[^\w.-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60)
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || fallback;
}
