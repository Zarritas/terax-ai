// Local, Terax-private session metadata (display name, tags, color).
// Persisted with the store plugin like AI chat sessions are; the backend
// never sees these. Keys combine provider and id since ids can collide
// across providers.

import { LazyStore } from "@tauri-apps/plugin-store";

export type SessionMetadata = {
  name?: string;
  tags?: string[];
  color?: string;
};

const store = new LazyStore("terax-agent-sessions.json", {
  defaults: {},
  autoSave: 200,
});

export function metadataKey(provider: string, id: string): string {
  return `${provider}:${id}`;
}

export async function loadAllMetadata(): Promise<
  Record<string, SessionMetadata>
> {
  const entries = await store.entries<SessionMetadata>();
  return Object.fromEntries(entries);
}

/** Merge `patch` into the session's metadata; empty fields are dropped and
 * an entry with nothing left is removed entirely. */
export async function setMetadata(
  provider: string,
  id: string,
  patch: Partial<SessionMetadata>,
): Promise<SessionMetadata | null> {
  const key = metadataKey(provider, id);
  const current = (await store.get<SessionMetadata>(key)) ?? {};
  const next: SessionMetadata = { ...current, ...patch };
  if (!next.name?.trim()) delete next.name;
  if (!next.tags?.length) delete next.tags;
  if (!next.color) delete next.color;
  if (Object.keys(next).length === 0) {
    await store.delete(key);
    await store.save();
    return null;
  }
  await store.set(key, next);
  await store.save();
  return next;
}

export async function deleteMetadata(
  provider: string,
  id: string,
): Promise<void> {
  await store.delete(metadataKey(provider, id));
  await store.save();
}

/** Lowercase, reserved chars ([,:]) stripped, whitespace runs collapsed to
 * '-'; null when nothing remains. Port of multi-claude's normalize_tag. */
export function normalizeTag(raw: string): string | null {
  const cleaned = raw
    .replace(/[,:]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

/** Split on commas/whitespace, normalize, dedup preserving first occurrence. */
export function parseTagList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const tag = normalizeTag(part);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/** Sorted union of every tag currently assigned, for suggestions. */
export function allKnownTags(
  metadata: Record<string, SessionMetadata>,
): string[] {
  const tags = new Set<string>();
  for (const meta of Object.values(metadata)) {
    for (const tag of meta.tags ?? []) tags.add(tag);
  }
  return [...tags].sort();
}
