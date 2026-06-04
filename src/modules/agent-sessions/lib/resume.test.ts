import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProviderInfo, AgentSession } from "./native";
import {
  type AgentSessionsBridgeDeps,
  argvToCommand,
  compactCommand,
  createAgentSessionsBridge,
} from "./resume";

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    provider: "claude",
    id: "sid-1",
    title: "Mi tarea",
    cwd: "/work/proj",
    branch: null,
    messageCount: null,
    sizeBytes: null,
    lastActivity: 0,
    isActive: false,
    contextTokens: null,
    contextWindow: null,
    model: null,
    startedAt: null,
    costUsd: null,
    liveStatus: null,
    resumeArgv: ["claude", "--resume", "sid-1"],
    ...overrides,
  };
}

function makeDeps(): AgentSessionsBridgeDeps & {
  writes: Array<[number, string]>;
} {
  const writes: Array<[number, string]> = [];
  return {
    writes,
    newAgentTab: vi.fn(() => ({ tabId: 10, leafId: 11 })),
    focusTab: vi.fn(),
    whenSessionReady: vi.fn(() => Promise.resolve()),
    writeToSession: vi.fn((leafId: number, data: string) => {
      writes.push([leafId, data]);
      return true;
    }),
    getManagedBySessionId: vi.fn(() => undefined),
    registerManaged: vi.fn(),
    removeManaged: vi.fn(),
    enableClaudeHooks: vi.fn(() => Promise.resolve()),
    notify: vi.fn(),
    fallbackCwd: vi.fn(() => "/home/user"),
    execIntoCommand: true,
  };
}

async function flush() {
  // Let the spawn IIFE's awaited promises settle.
  await new Promise((r) => setTimeout(r, 0));
}

describe("argvToCommand", () => {
  it("passes clean args through and quotes shell metacharacters", () => {
    expect(argvToCommand(["claude", "--resume", "abc-123"])).toBe(
      "claude --resume abc-123",
    );
    expect(argvToCommand(["echo", "a b", "it's"])).toBe(
      "echo 'a b' 'it'\\''s'",
    );
  });
});

describe("resumeSession", () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("focuses the existing tab instead of spawning a duplicate", () => {
    deps.getManagedBySessionId = vi.fn(() => ({ tabId: 3, leafId: 4 }));
    const bridge = createAgentSessionsBridge(deps);
    bridge.resumeSession(session({}));
    expect(deps.focusTab).toHaveBeenCalledWith({ tabId: 3, leafId: 4 });
    expect(deps.newAgentTab).not.toHaveBeenCalled();
    expect(deps.writeToSession).not.toHaveBeenCalled();
  });

  it("blocks sessions live in an external terminal with a notice", () => {
    const bridge = createAgentSessionsBridge(deps);
    bridge.resumeSession(session({ isActive: true }));
    expect(deps.notify).toHaveBeenCalledOnce();
    expect(deps.newAgentTab).not.toHaveBeenCalled();
  });

  it("spawns a tab in the session cwd and writes the resume command", async () => {
    const bridge = createAgentSessionsBridge(deps);
    bridge.resumeSession(session({}));
    expect(deps.newAgentTab).toHaveBeenCalledWith(
      "/work/proj",
      "claude · Mi tarea",
    );
    expect(deps.registerManaged).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sid-1", tabId: 10, leafId: 11 }),
    );
    await flush();
    // exec replaces the shell so quitting the agent closes the pane.
    expect(deps.writes).toEqual([[11, "exec claude --resume sid-1\r"]]);
    expect(deps.enableClaudeHooks).toHaveBeenCalled();
  });

  it("skips claude hooks for other providers and uses fallback cwd", async () => {
    const bridge = createAgentSessionsBridge(deps);
    bridge.resumeSession(
      session({
        provider: "codex",
        cwd: null,
        resumeArgv: ["codex", "resume", "sid-1"],
      }),
    );
    expect(deps.newAgentTab).toHaveBeenCalledWith(
      "/home/user",
      "codex · Mi tarea",
    );
    await flush();
    expect(deps.enableClaudeHooks).not.toHaveBeenCalled();
    expect(deps.writes).toEqual([[11, "exec codex resume sid-1\r"]]);
  });

  it("unregisters the managed agent when the PTY write fails", async () => {
    deps.writeToSession = vi.fn(() => false);
    const bridge = createAgentSessionsBridge(deps);
    bridge.resumeSession(session({}));
    await flush();
    expect(deps.removeManaged).toHaveBeenCalledWith(11);
  });
});

describe("newSession", () => {
  it("writes the provider's new-session command without registering", async () => {
    const deps = makeDeps();
    const provider: AgentProviderInfo = {
      id: "opencode",
      displayName: "OpenCode",
      available: true,
      binaryFound: true,
      newSessionArgv: ["opencode"],
    };
    const bridge = createAgentSessionsBridge(deps);
    bridge.newSession(provider, "/work/x");
    expect(deps.newAgentTab).toHaveBeenCalledWith(
      "/work/x",
      "opencode · new session",
    );
    expect(deps.registerManaged).not.toHaveBeenCalled();
    await flush();
    expect(deps.writes).toEqual([[11, "exec opencode\r"]]);
  });

  it("writes a plain command when exec is unavailable (Windows shells)", async () => {
    const deps = makeDeps();
    deps.execIntoCommand = false;
    const bridge = createAgentSessionsBridge(deps);
    bridge.resumeSession(session({}));
    await flush();
    expect(deps.writes).toEqual([[11, "claude --resume sid-1\r"]]);
  });
});

describe("compactCommand", () => {
  it("maps gemini to /compress and everything else to /compact", () => {
    expect(compactCommand("gemini")).toBe("/compress");
    for (const p of ["claude", "codex", "opencode"]) {
      expect(compactCommand(p)).toBe("/compact");
    }
  });
});

describe("compactLive", () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("returns false for sessions not managed by Terax", () => {
    const bridge = createAgentSessionsBridge(deps);
    expect(bridge.compactLive(session({ isActive: true }))).toBe(false);
    expect(deps.writeToSession).not.toHaveBeenCalled();
  });

  it("types the compact command into the managed PTY and focuses its tab", () => {
    deps.getManagedBySessionId = vi.fn(() => ({ tabId: 3, leafId: 4 }));
    const bridge = createAgentSessionsBridge(deps);
    expect(bridge.compactLive(session({ isActive: true }))).toBe(true);
    expect(deps.writes).toEqual([[4, "/compact\r"]]);
    expect(deps.focusTab).toHaveBeenCalledWith({ tabId: 3, leafId: 4 });
  });

  it("uses /compress for live gemini sessions", () => {
    deps.getManagedBySessionId = vi.fn(() => ({ tabId: 3, leafId: 4 }));
    const bridge = createAgentSessionsBridge(deps);
    bridge.compactLive(session({ provider: "gemini", isActive: true }));
    expect(deps.writes).toEqual([[4, "/compress\r"]]);
  });

  it("reports failure when the PTY write fails", () => {
    deps.getManagedBySessionId = vi.fn(() => ({ tabId: 3, leafId: 4 }));
    deps.writeToSession = vi.fn(() => false);
    const bridge = createAgentSessionsBridge(deps);
    expect(bridge.compactLive(session({}))).toBe(false);
    expect(deps.focusTab).not.toHaveBeenCalled();
  });
});
