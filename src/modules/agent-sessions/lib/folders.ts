// User-defined organization: nested project folders (port of multi-claude's
// project_folders.py cascade semantics) plus flat per-project session groups
// (new — multi-claude has no session grouping). All pure functions over an
// immutable FoldersState; persistence is a separate LazyStore.
//
// Folder paths use "/" as separator ("Trabajo/Cliente A"); names compare
// case-insensitively but keep their original casing for display. Renames and
// deletes cascade to descendants and assignments; deleting never deletes
// projects or sessions — they just fall back to the root.

import { LazyStore } from "@tauri-apps/plugin-store";

export const FOLDER_SEPARATOR = "/";

export type FoldersState = {
  /** Folder paths, ancestor-first ("Trabajo" before "Trabajo/Cliente A"). */
  projectFolders: string[];
  /** provider:cwd -> folder path. */
  projectAssignments: Record<string, string>;
  /** provider:cwd -> flat group names within that project. */
  sessionGroups: Record<string, string[]>;
  /** provider:sessionId -> group name (scoped by the session's project). */
  sessionAssignments: Record<string, string>;
};

export function emptyFoldersState(): FoldersState {
  return {
    projectFolders: [],
    projectAssignments: {},
    sessionGroups: {},
    sessionAssignments: {},
  };
}

export function projectKey(provider: string, cwd: string): string {
  return `${provider}:${cwd}`;
}

export function sessionKey(provider: string, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

// ---------------------------------------------------------------------------
// Path helpers (port of project_folders.py)
// ---------------------------------------------------------------------------

function validateSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) throw new Error("folder name cannot be empty");
  if (trimmed.includes(FOLDER_SEPARATOR)) {
    throw new Error(`folder name cannot contain "${FOLDER_SEPARATOR}"`);
  }
  return trimmed;
}

/** Canonical form: trimmed segments, empty ones collapsed; throws when
 * nothing remains. */
export function normalizeFolderPath(raw: string): string {
  const parts = raw
    .split(FOLDER_SEPARATOR)
    .filter((p) => p.trim())
    .map(validateSegment);
  if (!parts.length) throw new Error("folder path cannot be empty");
  return parts.join(FOLDER_SEPARATOR);
}

export function folderLeaf(path: string): string {
  const segs = path.split(FOLDER_SEPARATOR);
  return segs[segs.length - 1] ?? "";
}

export function folderParent(path: string): string | null {
  const segs = path.split(FOLDER_SEPARATOR);
  return segs.length > 1 ? segs.slice(0, -1).join(FOLDER_SEPARATOR) : null;
}

/** True when `path` is `ancestor` itself or lives under it (case-insensitive). */
function isSelfOrDescendant(path: string, ancestor: string): boolean {
  const p = path.toLowerCase();
  const a = ancestor.toLowerCase();
  return p === a || p.startsWith(`${a}${FOLDER_SEPARATOR}`);
}

function findCanonical(state: FoldersState, path: string): string | undefined {
  const lower = path.toLowerCase();
  return state.projectFolders.find((f) => f.toLowerCase() === lower);
}

// ---------------------------------------------------------------------------
// Project folders
// ---------------------------------------------------------------------------

/** Create `path` (and any missing ancestors). Idempotent; an existing folder
 * keeps its original casing and is returned canonically. */
export function addFolder(
  state: FoldersState,
  rawPath: string,
): { state: FoldersState; path: string } {
  const canonical = normalizeFolderPath(rawPath);
  const segments = canonical.split(FOLDER_SEPARATOR);
  let folders = state.projectFolders;
  let resolved: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    // Re-anchor each level on the existing casing when present.
    const candidate = [...resolved, segments[i]].join(FOLDER_SEPARATOR);
    const existing = folders.find(
      (f) => f.toLowerCase() === candidate.toLowerCase(),
    );
    if (existing) {
      resolved = existing.split(FOLDER_SEPARATOR);
    } else {
      resolved = candidate.split(FOLDER_SEPARATOR);
      folders = [...folders, resolved.join(FOLDER_SEPARATOR)];
    }
  }
  const path = resolved.join(FOLDER_SEPARATOR);
  if (folders === state.projectFolders) return { state, path };
  return { state: { ...state, projectFolders: folders }, path };
}

/** Rename the leaf of `oldPath`; descendants and assignments follow. */
export function renameFolder(
  state: FoldersState,
  oldPath: string,
  newLeaf: string,
): { state: FoldersState; path: string } {
  const oldCanonical = normalizeFolderPath(oldPath);
  const leaf = validateSegment(newLeaf);
  const parent = folderParent(oldCanonical);
  const newCanonical = parent ? `${parent}${FOLDER_SEPARATOR}${leaf}` : leaf;
  if (
    newCanonical.toLowerCase() !== oldCanonical.toLowerCase() &&
    findCanonical(state, newCanonical)
  ) {
    throw new Error(`folder already exists: ${newCanonical}`);
  }
  const rewrite = (path: string): string => {
    if (path.toLowerCase() === oldCanonical.toLowerCase()) return newCanonical;
    if (isSelfOrDescendant(path, oldCanonical)) {
      return newCanonical + path.slice(oldCanonical.length);
    }
    return path;
  };
  return {
    path: newCanonical,
    state: {
      ...state,
      projectFolders: state.projectFolders.map(rewrite),
      projectAssignments: Object.fromEntries(
        Object.entries(state.projectAssignments).map(([k, v]) => [
          k,
          rewrite(v),
        ]),
      ),
    },
  };
}

/** Delete `path` and every descendant; assigned projects fall back to root. */
export function deleteFolder(state: FoldersState, path: string): FoldersState {
  const target = normalizeFolderPath(path);
  return {
    ...state,
    projectFolders: state.projectFolders.filter(
      (f) => !isSelfOrDescendant(f, target),
    ),
    projectAssignments: Object.fromEntries(
      Object.entries(state.projectAssignments).filter(
        ([, folder]) => !isSelfOrDescendant(folder, target),
      ),
    ),
  };
}

export function assignProject(
  state: FoldersState,
  key: string,
  folderPath: string,
): FoldersState {
  const added = addFolder(state, folderPath);
  return {
    ...added.state,
    projectAssignments: {
      ...added.state.projectAssignments,
      [key]: added.path,
    },
  };
}

export function unassignProject(
  state: FoldersState,
  key: string,
): FoldersState {
  if (!(key in state.projectAssignments)) return state;
  const next = { ...state.projectAssignments };
  delete next[key];
  return { ...state, projectAssignments: next };
}

export function folderOfProject(
  state: FoldersState,
  key: string,
): string | null {
  return state.projectAssignments[key] ?? null;
}

// ---------------------------------------------------------------------------
// Session groups (flat, per project)
// ---------------------------------------------------------------------------

function validateGroupName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("group name cannot be empty");
  return trimmed;
}

export function createGroup(
  state: FoldersState,
  projKey: string,
  name: string,
): { state: FoldersState; name: string } {
  const trimmed = validateGroupName(name);
  const groups = state.sessionGroups[projKey] ?? [];
  const existing = groups.find(
    (g) => g.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existing) return { state, name: existing };
  return {
    name: trimmed,
    state: {
      ...state,
      sessionGroups: {
        ...state.sessionGroups,
        [projKey]: [...groups, trimmed],
      },
    },
  };
}

export function renameGroup(
  state: FoldersState,
  projKey: string,
  oldName: string,
  newName: string,
): FoldersState {
  const trimmed = validateGroupName(newName);
  const groups = state.sessionGroups[projKey] ?? [];
  const target = groups.find((g) => g.toLowerCase() === oldName.toLowerCase());
  if (!target) return state;
  if (
    trimmed.toLowerCase() !== target.toLowerCase() &&
    groups.some((g) => g.toLowerCase() === trimmed.toLowerCase())
  ) {
    throw new Error(`group already exists: ${trimmed}`);
  }
  return {
    ...state,
    sessionGroups: {
      ...state.sessionGroups,
      [projKey]: groups.map((g) => (g === target ? trimmed : g)),
    },
    sessionAssignments: Object.fromEntries(
      Object.entries(state.sessionAssignments).map(([k, v]) => [
        k,
        v === target ? trimmed : v,
      ]),
    ),
  };
}

export function deleteGroup(
  state: FoldersState,
  projKey: string,
  name: string,
): FoldersState {
  const groups = state.sessionGroups[projKey] ?? [];
  const target = groups.find((g) => g.toLowerCase() === name.toLowerCase());
  if (!target) return state;
  const nextGroups = { ...state.sessionGroups };
  const remaining = groups.filter((g) => g !== target);
  if (remaining.length) nextGroups[projKey] = remaining;
  else delete nextGroups[projKey];
  return {
    ...state,
    sessionGroups: nextGroups,
    sessionAssignments: Object.fromEntries(
      Object.entries(state.sessionAssignments).filter(([, v]) => v !== target),
    ),
  };
}

export function assignSession(
  state: FoldersState,
  projKey: string,
  sessKey: string,
  groupName: string,
): FoldersState {
  const created = createGroup(state, projKey, groupName);
  return {
    ...created.state,
    sessionAssignments: {
      ...created.state.sessionAssignments,
      [sessKey]: created.name,
    },
  };
}

export function unassignSession(
  state: FoldersState,
  sessKey: string,
): FoldersState {
  if (!(sessKey in state.sessionAssignments)) return state;
  const next = { ...state.sessionAssignments };
  delete next[sessKey];
  return { ...state, sessionAssignments: next };
}

// ---------------------------------------------------------------------------
// Load-time sanitation (dangling references are dropped, like multi-claude)
// ---------------------------------------------------------------------------

export function sanitizeFoldersState(raw: unknown): FoldersState {
  const state = emptyFoldersState();
  if (typeof raw !== "object" || raw === null) return state;
  const data = raw as Partial<Record<keyof FoldersState, unknown>>;

  if (Array.isArray(data.projectFolders)) {
    for (const entry of data.projectFolders) {
      if (typeof entry !== "string") continue;
      try {
        const added = addFolder(state, entry);
        state.projectFolders = added.state.projectFolders;
      } catch {
        // invalid stored path: drop it
      }
    }
  }
  if (data.projectAssignments && typeof data.projectAssignments === "object") {
    for (const [key, folder] of Object.entries(
      data.projectAssignments as Record<string, unknown>,
    )) {
      if (typeof folder !== "string") continue;
      const canonical = findCanonical(state, folder);
      if (canonical) state.projectAssignments[key] = canonical;
    }
  }
  if (data.sessionGroups && typeof data.sessionGroups === "object") {
    for (const [key, groups] of Object.entries(
      data.sessionGroups as Record<string, unknown>,
    )) {
      if (!Array.isArray(groups)) continue;
      const clean = groups.filter(
        (g): g is string => typeof g === "string" && g.trim().length > 0,
      );
      if (clean.length) state.sessionGroups[key] = clean;
    }
  }
  if (data.sessionAssignments && typeof data.sessionAssignments === "object") {
    const known = new Set(
      Object.values(state.sessionGroups)
        .flat()
        .map((g) => g.toLowerCase()),
    );
    for (const [key, group] of Object.entries(
      data.sessionAssignments as Record<string, unknown>,
    )) {
      if (typeof group === "string" && known.has(group.toLowerCase())) {
        state.sessionAssignments[key] = group;
      }
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const store = new LazyStore("terax-agent-folders.json", {
  defaults: {},
  autoSave: 200,
});

export async function loadFolders(): Promise<FoldersState> {
  const raw = Object.fromEntries(await store.entries());
  return sanitizeFoldersState(raw);
}

export async function saveFolders(state: FoldersState): Promise<void> {
  await store.set("projectFolders", state.projectFolders);
  await store.set("projectAssignments", state.projectAssignments);
  await store.set("sessionGroups", state.sessionGroups);
  await store.set("sessionAssignments", state.sessionAssignments);
  await store.save();
}
