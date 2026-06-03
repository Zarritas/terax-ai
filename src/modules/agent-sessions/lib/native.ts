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
