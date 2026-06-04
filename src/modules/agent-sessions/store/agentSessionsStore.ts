import { create } from "zustand";
import type { FoldersState } from "../lib/folders";
import { emptyFoldersState, saveFolders } from "../lib/folders";
import type { SessionMetadata } from "../lib/metadata";
import { metadataKey } from "../lib/metadata";
import type {
  AgentProviderInfo,
  AgentSession,
  ProviderQuota,
  ServiceStatus,
} from "../lib/native";

type AgentSessionsState = {
  providers: AgentProviderInfo[];
  sessions: AgentSession[];
  filter: string;
  loading: boolean;
  error: string | null;
  /** Collapsed project-group keys (cwd or "" for unknown); default expanded. */
  collapsed: Set<string>;
  /** Local metadata (rename/tags/color) keyed by provider:id. */
  metadata: Record<string, SessionMetadata>;
  /** provider:id keys matching the current content: search; null = no search. */
  searchIds: Set<string> | null;
  /** User folders/groups organization (persisted separately). */
  folders: FoldersState;
  /** Account-level usage windows per provider (session/weekly). */
  quotas: ProviderQuota[];
  /** Hosted-service health per provider. */
  serviceStatus: ServiceStatus[];
  setProviders: (providers: AgentProviderInfo[]) => void;
  setSessions: (sessions: AgentSession[]) => void;
  /** Re-stamp isActive from the live registry without a full rescan. */
  applyLiveSessions: (liveIds: ReadonlySet<string>) => void;
  setFilter: (filter: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  toggleCollapsed: (key: string) => void;
  setAllMetadata: (metadata: Record<string, SessionMetadata>) => void;
  updateMetadata: (
    provider: string,
    id: string,
    meta: SessionMetadata | null,
  ) => void;
  setSearchIds: (searchIds: Set<string> | null) => void;
  setFolders: (folders: FoldersState) => void;
  setQuotas: (quotas: ProviderQuota[]) => void;
  setServiceStatus: (serviceStatus: ServiceStatus[]) => void;
  /** Apply a pure folders transition optimistically and persist in background. */
  applyFolders: (mutate: (state: FoldersState) => FoldersState) => void;
};

export const useAgentSessionsStore = create<AgentSessionsState>((set) => ({
  providers: [],
  sessions: [],
  filter: "",
  loading: false,
  error: null,
  collapsed: new Set<string>(),
  metadata: {},
  searchIds: null,
  folders: emptyFoldersState(),
  quotas: [],
  serviceStatus: [],

  setProviders: (providers) => set({ providers }),
  setSessions: (sessions) => set({ sessions }),
  applyLiveSessions: (liveIds) =>
    set((s) => {
      if (!s.sessions.some((x) => x.isActive !== liveIds.has(x.id))) return s;
      return {
        sessions: s.sessions.map((x) =>
          x.isActive === liveIds.has(x.id)
            ? x
            : { ...x, isActive: liveIds.has(x.id) },
        ),
      };
    }),
  setFilter: (filter) => set({ filter }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  toggleCollapsed: (key) =>
    set((s) => {
      const collapsed = new Set(s.collapsed);
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      return { collapsed };
    }),
  setAllMetadata: (metadata) => set({ metadata }),
  updateMetadata: (provider, id, meta) =>
    set((s) => {
      const metadata = { ...s.metadata };
      const key = metadataKey(provider, id);
      if (meta === null) delete metadata[key];
      else metadata[key] = meta;
      return { metadata };
    }),
  setSearchIds: (searchIds) => set({ searchIds }),
  setFolders: (folders) => set({ folders }),
  setQuotas: (quotas) => set({ quotas }),
  setServiceStatus: (serviceStatus) => set({ serviceStatus }),
  applyFolders: (mutate) =>
    set((s) => {
      const folders = mutate(s.folders);
      if (folders === s.folders) return s;
      void saveFolders(folders).catch(() => {});
      return { folders };
    }),
}));
