// Type-only imports: erased at compile time, so pure helpers (and their
// vitest suite) never load the tauri API module at runtime.
import type { FoldersState } from "./folders";
import {
  FOLDER_SEPARATOR,
  folderLeaf,
  projectKey,
  sessionKey,
} from "./folders";
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

// ---------------------------------------------------------------------------
// Hierarchical grouping: provider -> folder tree -> project -> session groups
// ---------------------------------------------------------------------------

export type SessionGroupNode = {
  name: string;
  sessions: AgentSession[];
};

export type ProjectNode = ProjectGroup & {
  groups: SessionGroupNode[];
  looseSessions: AgentSession[];
};

export type FolderNode = {
  path: string;
  name: string;
  depth: number;
  children: FolderNode[];
  projects: ProjectNode[];
  sessionCount: number;
  activeCount: number;
};

export type ProviderTree = {
  provider: AgentProviderId;
  folderTree: FolderNode[];
  looseProjects: ProjectNode[];
  sessionCount: number;
  activeCount: number;
};

function toProjectNode(
  provider: string,
  project: ProjectGroup,
  folders: FoldersState,
  pruneEmptyGroups: boolean,
): ProjectNode {
  const key = projectKey(provider, project.cwd ?? "");
  const groupNames = folders.sessionGroups[key] ?? [];
  const byGroup = new Map<string, AgentSession[]>(
    groupNames.map((name) => [name, []]),
  );
  const loose: AgentSession[] = [];
  for (const session of project.sessions) {
    const group = folders.sessionAssignments[sessionKey(provider, session.id)];
    const bucket = group ? byGroup.get(group) : undefined;
    if (bucket) bucket.push(session);
    else loose.push(session);
  }
  const groups: SessionGroupNode[] = groupNames
    .map((name) => ({ name, sessions: byGroup.get(name) ?? [] }))
    .filter((g) => !pruneEmptyGroups || g.sessions.length > 0);
  return { ...project, groups, looseSessions: loose };
}

function folderTotals(node: FolderNode): void {
  for (const child of node.children) folderTotals(child);
  node.sessionCount =
    node.projects.reduce((acc, p) => acc + p.sessions.length, 0) +
    node.children.reduce((acc, c) => acc + c.sessionCount, 0);
  node.activeCount =
    node.projects.reduce(
      (acc, p) => acc + p.sessions.filter((s) => s.isActive).length,
      0,
    ) + node.children.reduce((acc, c) => acc + c.activeCount, 0);
}

/** Drop folders that hold no projects of this provider anywhere below. */
function pruneFolders(nodes: FolderNode[]): FolderNode[] {
  const kept: FolderNode[] = [];
  for (const node of nodes) {
    node.children = pruneFolders(node.children);
    if (node.projects.length || node.children.length) kept.push(node);
  }
  return kept;
}

/**
 * Provider sections with user folders applied: assigned projects nest under
 * their folder (folders shown only where they hold projects of the provider),
 * unassigned projects stay loose below. `pruneEmptyGroups` should be true
 * while a filter is active so empty session groups vanish with it.
 */
export function groupByProviderWithFolders(
  sessions: AgentSession[],
  folders: FoldersState,
  pruneEmptyGroups: boolean,
): ProviderTree[] {
  return groupByProviderThenProject(sessions).map((section) => {
    const nodes = new Map<string, FolderNode>();
    // Ancestor-first order guarantees parents exist before children.
    for (const path of folders.projectFolders) {
      const depth = path.split(FOLDER_SEPARATOR).length - 1;
      nodes.set(path.toLowerCase(), {
        path,
        name: folderLeaf(path),
        depth,
        children: [],
        projects: [],
        sessionCount: 0,
        activeCount: 0,
      });
    }
    const roots: FolderNode[] = [];
    for (const path of folders.projectFolders) {
      const node = nodes.get(path.toLowerCase());
      if (!node) continue;
      const parentIdx = path.lastIndexOf(FOLDER_SEPARATOR);
      const parent =
        parentIdx > 0
          ? nodes.get(path.slice(0, parentIdx).toLowerCase())
          : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }

    const loose: ProjectNode[] = [];
    for (const project of section.projects) {
      const node = toProjectNode(
        section.provider,
        project,
        folders,
        pruneEmptyGroups,
      );
      const assigned =
        folders.projectAssignments[
          projectKey(section.provider, project.cwd ?? "")
        ];
      const folder = assigned ? nodes.get(assigned.toLowerCase()) : undefined;
      if (folder) folder.projects.push(node);
      else loose.push(node);
    }

    const folderTree = pruneFolders(roots);
    for (const node of folderTree) folderTotals(node);
    return {
      provider: section.provider,
      folderTree,
      looseProjects: loose,
      sessionCount: section.sessionCount,
      activeCount: section.activeCount,
    };
  });
}

/** Compact token count: 857 -> "857", 85_700 -> "86k", 1_230_000 -> "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const m = n / 1_000_000;
  return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M`;
}

/** Percentage of the context window consumed, clamped to [0, 100]. */
export function contextPercent(tokens: number, window: number): number {
  if (window <= 0) return 0;
  return Math.min(100, Math.round((tokens / window) * 100));
}

/** Color by how much context remains: quiet until half, then escalating. */
export function contextColorClass(percentUsed: number): string {
  if (percentUsed >= 90) return "text-red-500";
  if (percentUsed >= 75) return "text-orange-500";
  if (percentUsed >= 50) return "text-amber-500";
  return "text-muted-foreground";
}
