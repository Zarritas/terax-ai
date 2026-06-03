// Resume/new-session bridge. Built in App.tsx (where the tab and terminal
// primitives live) and handed to the panel as a prop, mirroring how
// SourceControlPanel receives its tab-opening callbacks. Kept as a pure
// factory over injected deps so the duplicate-session policy is unit-testable.

import type { AgentProviderInfo, AgentSession } from "./native";
import { sessionLabel } from "./parse";

export type ManagedAgentRef = { tabId: number; leafId: number };

export type AgentSessionsBridgeDeps = {
  newAgentTab: (cwd: string | undefined, title: string) => ManagedAgentRef;
  focusTab: (ref: ManagedAgentRef) => void;
  whenSessionReady: (leafId: number) => Promise<void>;
  writeToSession: (leafId: number, data: string) => boolean;
  getManagedBySessionId: (sessionId: string) => ManagedAgentRef | undefined;
  registerManaged: (a: {
    leafId: number;
    tabId: number;
    sessionId: string;
    task: string;
    cwd: string | null;
  }) => void;
  removeManaged: (leafId: number) => void;
  /** Resolves when Claude Code's OSC hooks are installed; other providers skip it. */
  enableClaudeHooks: () => Promise<unknown>;
  notify: (message: string) => void;
  /** Fallback cwd for sessions whose provider couldn't recover one. */
  fallbackCwd: () => string | null;
};

export type AgentSessionsBridge = {
  resumeSession: (session: AgentSession) => void;
  newSession: (provider: AgentProviderInfo, cwd: string | null) => void;
};

/** Join argv into a shell line. Quotes any arg with characters the shell
 * would interpret; session ids and binaries are clean, so this is a guard. */
export function argvToCommand(argv: string[]): string {
  return argv
    .map((arg) =>
      /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`,
    )
    .join(" ");
}

export function createAgentSessionsBridge(
  deps: AgentSessionsBridgeDeps,
): AgentSessionsBridge {
  const spawn = (
    argv: string[],
    cwd: string | null,
    title: string,
    sessionId: string | null,
    provider: string,
  ) => {
    if (!argv.length) return;
    const targetCwd = cwd ?? deps.fallbackCwd();
    const ref = deps.newAgentTab(targetCwd ?? undefined, title);
    if (sessionId) {
      deps.registerManaged({
        leafId: ref.leafId,
        tabId: ref.tabId,
        sessionId,
        task: title,
        cwd: targetCwd,
      });
    }
    const hooks =
      provider === "claude"
        ? deps.enableClaudeHooks().catch(() => {})
        : Promise.resolve();
    void (async () => {
      await Promise.all([deps.whenSessionReady(ref.leafId), hooks]);
      if (
        !deps.writeToSession(ref.leafId, `${argvToCommand(argv)}\r`) &&
        sessionId
      ) {
        deps.removeManaged(ref.leafId);
      }
    })();
  };

  return {
    resumeSession: (session) => {
      // Never two terminals on one session: focus the tab Terax already runs.
      const existing = deps.getManagedBySessionId(session.id);
      if (existing) {
        deps.focusTab(existing);
        return;
      }
      // Live somewhere outside Terax (only Claude's registry can tell):
      // resuming would race two processes over one session log.
      if (session.isActive) {
        deps.notify("Session is already running in another terminal");
        return;
      }
      spawn(
        session.resumeArgv,
        session.cwd,
        `${session.provider} · ${sessionLabel(session)}`,
        session.id,
        session.provider,
      );
    },

    newSession: (provider, cwd) => {
      spawn(
        provider.newSessionArgv,
        cwd,
        `${provider.id} · new session`,
        null,
        provider.id,
      );
    },
  };
}
