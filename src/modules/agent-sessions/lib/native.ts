import { invoke } from "@tauri-apps/api/core";

export type AgentProviderId = "claude" | "codex" | "opencode" | "gemini";

export type AgentSession = {
  provider: AgentProviderId;
  id: string;
  title: string | null;
  cwd: string | null;
  branch: string | null;
  messageCount: number | null;
  sizeBytes: number | null;
  /** Unix seconds. */
  lastActivity: number;
  isActive: boolean;
  /** Context-window tokens of the latest model turn, when recorded. */
  contextTokens: number | null;
  /** Model of the latest turn (e.g. "claude-opus-4-8"). */
  model: string | null;
  /** Unix seconds of the first event. */
  startedAt: number | null;
  /** Estimated API-equivalent cost in USD. */
  costUsd: number | null;
  /** "busy" | "idle" | other registry states, when the session is live. */
  liveStatus: string | null;
  /** Model context window size (exact for codex, inferred for claude). */
  contextWindow: number | null;
  /** Backend-built argv to resume this session in a terminal. */
  resumeArgv: string[];
};

export type AgentProviderInfo = {
  id: AgentProviderId;
  displayName: string;
  available: boolean;
  binaryFound: boolean;
  newSessionArgv: string[];
};

export type LiveAgentSession = {
  provider: AgentProviderId;
  sessionId: string;
  pid: number;
  status: string | null;
};

export function listProviders(): Promise<AgentProviderInfo[]> {
  return invoke<AgentProviderInfo[]>("agent_providers");
}

export function listSessions(force = false): Promise<AgentSession[]> {
  return invoke<AgentSession[]>("agent_list_sessions", { force });
}

export function listLiveSessions(): Promise<LiveAgentSession[]> {
  return invoke<LiveAgentSession[]>("agent_live_sessions");
}

export type PreviewTurn = {
  role: "user" | "assistant";
  text: string;
};

export type SessionRef = {
  provider: AgentProviderId;
  sessionId: string;
};

export function deleteSession(
  provider: AgentProviderId,
  sessionId: string,
  force = false,
): Promise<void> {
  return invoke("agent_delete_session", { provider, sessionId, force });
}

/** Headless context compaction; resolves when the CLI run finishes (minutes
 * on big sessions). Rejects with "ACTIVE" (session live) or "UNSUPPORTED"
 * (provider has no headless compact). */
export function compactSession(
  provider: AgentProviderId,
  sessionId: string,
  cwd: string | null,
): Promise<void> {
  return invoke("agent_compact_session", { provider, sessionId, cwd });
}

export function previewSession(
  provider: AgentProviderId,
  sessionId: string,
): Promise<PreviewTurn[]> {
  return invoke<PreviewTurn[]>("agent_session_preview", {
    provider,
    sessionId,
  });
}

export function searchSessions(query: string): Promise<SessionRef[]> {
  return invoke<SessionRef[]>("agent_search_sessions", { query });
}

export type ExportItem = {
  sessionId: string;
  displayName?: string | null;
  tags?: string[];
};

export type ManifestSessionInfo = {
  id: string;
  displayName: string | null;
  firstPrompt: string | null;
  tags: string[];
};

export type ImportOutcome = {
  imported: ManifestSessionInfo[];
  skippedExisting: string[];
  skippedMissing: string[];
};

export function exportSessions(
  items: ExportItem[],
  destPath: string,
): Promise<number> {
  return invoke<number>("agent_export_sessions", { items, destPath });
}

export function readManifest(zipPath: string): Promise<ManifestSessionInfo[]> {
  return invoke<ManifestSessionInfo[]>("agent_read_manifest", { zipPath });
}

export function importSessions(
  zipPath: string,
  destCwd: string,
): Promise<ImportOutcome> {
  return invoke<ImportOutcome>("agent_import_sessions", { zipPath, destCwd });
}

export function moveSession(
  sessionId: string,
  sourceCwd: string,
  destCwd: string,
): Promise<void> {
  return invoke("agent_move_session", { sessionId, sourceCwd, destCwd });
}

export type QuotaWindow = {
  label: "session" | "weekly";
  usedPercent: number;
  resetsAt: number | null;
};

export type ProviderQuota = {
  provider: AgentProviderId;
  windows: QuotaWindow[];
  asOf: number | null;
};

export function listQuotas(): Promise<ProviderQuota[]> {
  return invoke<ProviderQuota[]>("agent_quotas");
}

export type ServiceStatus = {
  provider: AgentProviderId;
  indicator: "none" | "minor" | "major" | "critical" | "unknown";
  description: string;
};

export function listServiceStatus(): Promise<ServiceStatus[]> {
  return invoke<ServiceStatus[]>("agent_service_status");
}
