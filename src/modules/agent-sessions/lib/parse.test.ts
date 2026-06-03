import { describe, expect, it } from "vitest";
import type { AgentSession } from "./native";
import {
  formatBytes,
  formatRelativeTime,
  groupByProject,
  matchesFilter,
  sessionLabel,
} from "./parse";

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    provider: "claude",
    id: "abc-123",
    title: null,
    cwd: null,
    branch: null,
    messageCount: null,
    sizeBytes: null,
    lastActivity: 0,
    isActive: false,
    resumeArgv: ["claude", "--resume", "abc-123"],
    ...overrides,
  };
}

describe("sessionLabel", () => {
  it("prefers the title", () => {
    expect(sessionLabel(session({ title: "Mi refactor" }))).toBe("Mi refactor");
  });

  it("falls back to a trimmed id", () => {
    const s = session({ id: "0123456789abcdef0123456789" });
    expect(sessionLabel(s)).toBe("0123456789abcdef01…");
    expect(sessionLabel(session({ id: "short" }))).toBe("short");
  });
});

describe("matchesFilter", () => {
  const s = session({
    title: "Arregla el parser",
    cwd: "/work/gextia/connector",
    branch: "feat/parser",
  });

  it("empty query matches", () => {
    expect(matchesFilter(s, "")).toBe(true);
    expect(matchesFilter(s, "   ")).toBe(true);
  });

  it("matches across fields, case-insensitive", () => {
    expect(matchesFilter(s, "PARSER")).toBe(true);
    expect(matchesFilter(s, "connector")).toBe(true);
    expect(matchesFilter(s, "feat/parser")).toBe(true);
  });

  it("requires every word to match (AND)", () => {
    expect(matchesFilter(s, "parser connector")).toBe(true);
    expect(matchesFilter(s, "parser nomatch")).toBe(false);
  });
});

describe("groupByProject", () => {
  it("groups by cwd with newest group first and unknown last", () => {
    const groups = groupByProject([
      session({ id: "a", cwd: "/work/x", lastActivity: 100 }),
      session({ id: "b", cwd: "/work/y", lastActivity: 300 }),
      session({ id: "c", cwd: "/work/x", lastActivity: 200 }),
      session({ id: "d", cwd: null, lastActivity: 999 }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["y", "x", "(unknown location)"]);
    // Sessions newest-first inside the group.
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["c", "a"]);
    expect(groups[1].lastActivity).toBe(200);
  });
});

describe("formatRelativeTime", () => {
  const now = 1_780_000_000_000; // ms
  const at = (secsAgo: number) => now / 1000 - secsAgo;

  it("formats each magnitude compactly", () => {
    expect(formatRelativeTime(at(10), now)).toBe("now");
    expect(formatRelativeTime(at(5 * 60), now)).toBe("5m");
    expect(formatRelativeTime(at(3 * 3600), now)).toBe("3h");
    expect(formatRelativeTime(at(2 * 86_400), now)).toBe("2d");
    expect(formatRelativeTime(at(30 * 86_400), now)).toBe("4w");
  });

  it("clamps future timestamps to now", () => {
    expect(formatRelativeTime(now / 1000 + 999, now)).toBe("now");
  });
});

describe("formatBytes", () => {
  it("scales units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
  });
});
