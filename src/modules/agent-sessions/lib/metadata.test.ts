import { describe, expect, it } from "vitest";
import type { SessionMetadata } from "./metadata";
import {
  allKnownTags,
  metadataKey,
  normalizeTag,
  parseTagList,
} from "./metadata";

describe("normalizeTag", () => {
  it("lowercases and collapses whitespace to dashes", () => {
    expect(normalizeTag("Cliente  ACME")).toBe("cliente-acme");
    expect(normalizeTag("  Bug ")).toBe("bug");
  });

  it("strips reserved characters", () => {
    expect(normalizeTag("a,b:c")).toBe("abc");
  });

  it("returns null when nothing remains", () => {
    expect(normalizeTag("  ,,, ::")).toBeNull();
    expect(normalizeTag("")).toBeNull();
  });
});

describe("parseTagList", () => {
  it("splits on commas and whitespace, dedups preserving order", () => {
    expect(parseTagList("bug urgent, cliente-acme bug")).toEqual([
      "bug",
      "urgent",
      "cliente-acme",
    ]);
  });

  it("drops empty fragments", () => {
    expect(parseTagList(" , ,, ")).toEqual([]);
  });
});

describe("allKnownTags", () => {
  it("returns the sorted union", () => {
    const metadata: Record<string, SessionMetadata> = {
      "claude:a": { tags: ["zeta", "bug"] },
      "codex:b": { tags: ["bug", "alfa"] },
      "gemini:c": { name: "sin tags" },
    };
    expect(allKnownTags(metadata)).toEqual(["alfa", "bug", "zeta"]);
  });
});

describe("metadataKey", () => {
  it("namespaces by provider to avoid id collisions", () => {
    expect(metadataKey("claude", "x")).toBe("claude:x");
    expect(metadataKey("codex", "x")).toBe("codex:x");
  });
});
