import { describe, expect, it } from "vitest";
import {
  addFolder,
  assignProject,
  assignSession,
  emptyFoldersState,
} from "./folders";
import type { AgentSession } from "./native";
import {
  colorClasses,
  contextColorClass,
  contextPercent,
  formatBytes,
  formatRelativeTime,
  formatTokens,
  groupByProject,
  groupByProviderThenProject,
  groupByProviderWithFolders,
  matchesFilter,
  parseFilter,
  safeFilename,
  sessionLabel,
} from "./parse";

const match = (
  s: AgentSession,
  q: string,
  meta?: Parameters<typeof matchesFilter>[2],
) => matchesFilter(s, parseFilter(q), meta);

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
    contextTokens: null,
    contextWindow: null,
    resumeArgv: ["claude", "--resume", "abc-123"],
    ...overrides,
  };
}

describe("sessionLabel", () => {
  it("prefers the title", () => {
    expect(sessionLabel(session({ title: "Mi refactor" }))).toBe("Mi refactor");
  });

  it("local rename wins over the title", () => {
    expect(
      sessionLabel(session({ title: "Mi refactor" }), { name: "Renombrada" }),
    ).toBe("Renombrada");
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
    expect(match(s, "")).toBe(true);
    expect(match(s, "   ")).toBe(true);
  });

  it("matches across fields, case-insensitive", () => {
    expect(match(s, "PARSER")).toBe(true);
    expect(match(s, "connector")).toBe(true);
    expect(match(s, "feat/parser")).toBe(true);
  });

  it("requires every word to match (AND)", () => {
    expect(match(s, "parser connector")).toBe(true);
    expect(match(s, "parser nomatch")).toBe(false);
  });

  it("matches local rename and tags in the free-text haystack", () => {
    const meta = { name: "Mi nombre local", tags: ["urgente"] };
    expect(match(s, "nombre local", meta)).toBe(true);
    expect(match(s, "urgente", meta)).toBe(true);
  });

  it("tag: predicate requires every listed tag (AND)", () => {
    const meta = { tags: ["bug", "cliente-acme"] };
    expect(match(s, "tag:bug", meta)).toBe(true);
    expect(match(s, "tag:bug,acme", meta)).toBe(true);
    expect(match(s, "tag:bug,otro", meta)).toBe(false);
    expect(match(s, "tag:bug")).toBe(false); // sin meta no hay tags
  });

  it("branch:/id:/path: predicates filter on their fields", () => {
    expect(match(s, "branch:feat")).toBe(true);
    expect(match(s, "branch:main")).toBe(false);
    expect(match(s, "id:abc")).toBe(true);
    expect(match(s, "path:gextia")).toBe(true);
    expect(match(s, "path:otro")).toBe(false);
  });
});

describe("parseFilter", () => {
  it("separates content terms from predicates and free text", () => {
    const parsed = parseFilter("content:facturas tag:bug parser content:iva");
    expect(parsed.content).toBe("facturas iva");
    expect(parsed.predicates).toEqual([{ key: "tag", value: "bug" }]);
    expect(parsed.text).toBe("parser");
  });

  it("unknown prefixes stay as free text", () => {
    const parsed = parseFilter("foo:bar baz");
    expect(parsed.content).toBeNull();
    expect(parsed.predicates).toEqual([]);
    expect(parsed.text).toBe("foo:bar baz");
  });
});

describe("colorClasses", () => {
  it("resolves known tokens and rejects unknown", () => {
    expect(colorClasses("sky")?.bar).toBe("bg-sky-500");
    expect(colorClasses("nope")).toBeNull();
    expect(colorClasses(undefined)).toBeNull();
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

describe("groupByProviderThenProject", () => {
  it("sections by provider in stable order, projects inside", () => {
    const groups = groupByProviderThenProject([
      session({
        id: "o1",
        provider: "opencode",
        cwd: "/w/x",
        lastActivity: 900,
      }),
      session({ id: "c1", provider: "claude", cwd: "/w/x", lastActivity: 100 }),
      session({
        id: "c2",
        provider: "claude",
        cwd: "/w/y",
        lastActivity: 300,
        isActive: true,
      }),
      session({ id: "x1", provider: "codex", cwd: "/w/x", lastActivity: 200 }),
    ]);
    // Registry order regardless of recency; gemini absent (no sessions).
    expect(groups.map((g) => g.provider)).toEqual([
      "claude",
      "codex",
      "opencode",
    ]);
    const claude = groups[0];
    expect(claude.sessionCount).toBe(2);
    expect(claude.activeCount).toBe(1);
    expect(claude.lastActivity).toBe(300);
    expect(claude.projects.map((p) => p.name)).toEqual(["y", "x"]);
  });

  it("returns empty for no sessions", () => {
    expect(groupByProviderThenProject([])).toEqual([]);
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

describe("safeFilename", () => {
  it("slugs labels and caps length", () => {
    expect(safeFilename("Arregla el parser!! (v2)")).toBe(
      "Arregla-el-parser-v2",
    );
    expect(safeFilename("  --..  ")).toBe("session");
    expect(safeFilename("x".repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe("context usage helpers", () => {
  it("computes clamped percentages", () => {
    expect(contextPercent(857_000, 1_000_000)).toBe(86);
    expect(contextPercent(50_000, 200_000)).toBe(25);
    expect(contextPercent(2_000_000, 1_000_000)).toBe(100);
    expect(contextPercent(10, 0)).toBe(0);
  });

  it("escalates color as context runs out", () => {
    expect(contextColorClass(10)).toBe("text-muted-foreground");
    expect(contextColorClass(55)).toBe("text-amber-500");
    expect(contextColorClass(80)).toBe("text-orange-500");
    expect(contextColorClass(95)).toBe("text-red-500");
  });
});

describe("formatTokens", () => {
  it("compacts magnitudes", () => {
    expect(formatTokens(857)).toBe("857");
    expect(formatTokens(85_700)).toBe("86k");
    expect(formatTokens(857_244)).toBe("857k");
    expect(formatTokens(1_230_000)).toBe("1.2M");
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

describe("groupByProviderWithFolders", () => {
  function fixtureFolders() {
    let f = emptyFoldersState();
    f = assignProject(f, "claude:/w/a", "Trabajo/Gextia");
    f = assignSession(f, "claude:/w/a", "claude:s1", "Bugs");
    return f;
  }
  const fixtureSessions = [
    session({ id: "s1", cwd: "/w/a", lastActivity: 100 }),
    session({ id: "s2", cwd: "/w/a", lastActivity: 200 }),
    session({ id: "s3", cwd: "/w/b", lastActivity: 300 }),
    session({ id: "x1", provider: "codex", cwd: "/w/a", lastActivity: 50 }),
  ];

  it("nests assigned projects under their folder tree", () => {
    const [claude, codex] = groupByProviderWithFolders(
      fixtureSessions,
      fixtureFolders(),
      false,
    );
    expect(claude.provider).toBe("claude");
    // /w/b is unassigned -> loose; /w/a sits under Trabajo > Gextia.
    expect(claude.looseProjects.map((p) => p.cwd)).toEqual(["/w/b"]);
    expect(claude.folderTree).toHaveLength(1);
    const trabajo = claude.folderTree[0];
    expect(trabajo.name).toBe("Trabajo");
    expect(trabajo.depth).toBe(0);
    expect(trabajo.projects).toHaveLength(0);
    expect(trabajo.children[0].name).toBe("Gextia");
    expect(trabajo.children[0].projects[0].cwd).toBe("/w/a");
    expect(trabajo.sessionCount).toBe(2);
    // The codex project at /w/a is NOT assigned (keys are per provider).
    expect(codex.provider).toBe("codex");
    expect(codex.folderTree).toHaveLength(0);
    expect(codex.looseProjects).toHaveLength(1);
  });

  it("splits sessions into groups and loose within a project", () => {
    const [claude] = groupByProviderWithFolders(
      fixtureSessions,
      fixtureFolders(),
      false,
    );
    const projA = claude.folderTree[0].children[0].projects[0];
    expect(projA.groups).toEqual([
      { name: "Bugs", sessions: [expect.objectContaining({ id: "s1" })] },
    ]);
    expect(projA.looseSessions.map((s) => s.id)).toEqual(["s2"]);
  });

  it("prunes empty groups when filtering and empty folders always", () => {
    let f = fixtureFolders();
    // A folder with no projects of this provider must not render.
    ({ state: f } = addFolder(f, "Vacia"));
    const onlyS2 = fixtureSessions.filter((s) => s.id === "s2");
    const [claude] = groupByProviderWithFolders(onlyS2, f, true);
    const projA = claude.folderTree[0].children[0].projects[0];
    expect(projA.groups).toHaveLength(0); // "Bugs" pruned (its session filtered out)
    expect(claude.folderTree.map((n) => n.name)).toEqual(["Trabajo"]);
  });
});
