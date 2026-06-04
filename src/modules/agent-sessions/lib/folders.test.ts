import { describe, expect, it } from "vitest";
import {
  addFolder,
  assignProject,
  assignSession,
  createGroup,
  deleteFolder,
  deleteGroup,
  emptyFoldersState,
  folderLeaf,
  folderOfProject,
  folderParent,
  normalizeFolderPath,
  renameFolder,
  renameGroup,
  sanitizeFoldersState,
  unassignProject,
  unassignSession,
} from "./folders";

describe("normalizeFolderPath", () => {
  it("trims segments and collapses empties", () => {
    expect(normalizeFolderPath(" Trabajo / Cliente A ")).toBe(
      "Trabajo/Cliente A",
    );
    expect(normalizeFolderPath("Trabajo//Cliente")).toBe("Trabajo/Cliente");
  });

  it("rejects empty paths", () => {
    expect(() => normalizeFolderPath("  ")).toThrow();
    expect(() => normalizeFolderPath("//")).toThrow();
  });
});

describe("folder path helpers", () => {
  it("leaf and parent", () => {
    expect(folderLeaf("A/B/C")).toBe("C");
    expect(folderParent("A/B/C")).toBe("A/B");
    expect(folderParent("A")).toBeNull();
  });
});

describe("addFolder", () => {
  it("creates ancestors and is idempotent", () => {
    let s = emptyFoldersState();
    ({ state: s } = addFolder(s, "Trabajo/Cliente A/Backend"));
    expect(s.projectFolders).toEqual([
      "Trabajo",
      "Trabajo/Cliente A",
      "Trabajo/Cliente A/Backend",
    ]);
    const again = addFolder(s, "trabajo/cliente a");
    expect(again.state).toBe(s); // no change
    expect(again.path).toBe("Trabajo/Cliente A"); // original casing wins
  });
});

describe("renameFolder cascade", () => {
  it("renames descendants and assignments", () => {
    let s = emptyFoldersState();
    s = assignProject(s, "claude:/w/a", "Work/Cliente A");
    s = assignProject(s, "claude:/w/b", "Work/Cliente A/Backend");
    const renamed = renameFolder(s, "Work/Cliente A", "Cliente B");
    expect(renamed.path).toBe("Work/Cliente B");
    expect(renamed.state.projectFolders).toContain("Work/Cliente B");
    expect(renamed.state.projectFolders).toContain("Work/Cliente B/Backend");
    expect(renamed.state.projectFolders).not.toContain("Work/Cliente A");
    expect(folderOfProject(renamed.state, "claude:/w/a")).toBe(
      "Work/Cliente B",
    );
    expect(folderOfProject(renamed.state, "claude:/w/b")).toBe(
      "Work/Cliente B/Backend",
    );
  });

  it("rejects collisions case-insensitively", () => {
    let s = emptyFoldersState();
    ({ state: s } = addFolder(s, "Work/Uno"));
    ({ state: s } = addFolder(s, "Work/Dos"));
    expect(() => renameFolder(s, "Work/Uno", "dos")).toThrow(/already exists/);
  });

  it("allows pure case changes of itself", () => {
    let s = emptyFoldersState();
    ({ state: s } = addFolder(s, "trabajo"));
    const renamed = renameFolder(s, "trabajo", "Trabajo");
    expect(renamed.state.projectFolders).toEqual(["Trabajo"]);
  });
});

describe("deleteFolder cascade", () => {
  it("removes descendants, unassigns projects, keeps ancestors", () => {
    let s = emptyFoldersState();
    s = assignProject(s, "claude:/w/a", "Work/Cliente A");
    s = assignProject(s, "claude:/w/b", "Work/Cliente A/Backend");
    s = assignProject(s, "claude:/w/c", "Work");
    s = deleteFolder(s, "Work/Cliente A");
    expect(s.projectFolders).toEqual(["Work"]);
    expect(folderOfProject(s, "claude:/w/a")).toBeNull();
    expect(folderOfProject(s, "claude:/w/b")).toBeNull();
    expect(folderOfProject(s, "claude:/w/c")).toBe("Work");
  });
});

describe("project assignment", () => {
  it("assign creates the folder; unassign keeps it", () => {
    let s = emptyFoldersState();
    s = assignProject(s, "codex:/w/x", "Nueva");
    expect(s.projectFolders).toEqual(["Nueva"]);
    s = unassignProject(s, "codex:/w/x");
    expect(folderOfProject(s, "codex:/w/x")).toBeNull();
    expect(s.projectFolders).toEqual(["Nueva"]);
  });
});

describe("session groups", () => {
  const PROJ = "claude:/w/p";

  it("create is idempotent case-insensitively", () => {
    let s = emptyFoldersState();
    ({ state: s } = createGroup(s, PROJ, "Backend"));
    const again = createGroup(s, PROJ, "backend");
    expect(again.state).toBe(s);
    expect(again.name).toBe("Backend");
  });

  it("assign creates the group on demand", () => {
    let s = emptyFoldersState();
    s = assignSession(s, PROJ, "claude:sid-1", "Bugs");
    expect(s.sessionGroups[PROJ]).toEqual(["Bugs"]);
    expect(s.sessionAssignments["claude:sid-1"]).toBe("Bugs");
  });

  it("rename cascades to assignments and rejects collisions", () => {
    let s = emptyFoldersState();
    s = assignSession(s, PROJ, "claude:sid-1", "Bugs");
    ({ state: s } = createGroup(s, PROJ, "Features"));
    s = renameGroup(s, PROJ, "bugs", "Incidencias");
    expect(s.sessionGroups[PROJ]).toEqual(["Incidencias", "Features"]);
    expect(s.sessionAssignments["claude:sid-1"]).toBe("Incidencias");
    expect(() => renameGroup(s, PROJ, "Incidencias", "features")).toThrow(
      /already exists/,
    );
  });

  it("delete unassigns sessions but keeps them", () => {
    let s = emptyFoldersState();
    s = assignSession(s, PROJ, "claude:sid-1", "Bugs");
    s = deleteGroup(s, PROJ, "Bugs");
    expect(s.sessionGroups[PROJ]).toBeUndefined();
    expect(s.sessionAssignments["claude:sid-1"]).toBeUndefined();
  });

  it("unassignSession leaves the group in place", () => {
    let s = emptyFoldersState();
    s = assignSession(s, PROJ, "claude:sid-1", "Bugs");
    s = unassignSession(s, "claude:sid-1");
    expect(s.sessionGroups[PROJ]).toEqual(["Bugs"]);
    expect(s.sessionAssignments["claude:sid-1"]).toBeUndefined();
  });
});

describe("sanitizeFoldersState", () => {
  it("drops dangling and malformed entries", () => {
    const state = sanitizeFoldersState({
      projectFolders: ["Work", "  ", 42, "Work/Sub"],
      projectAssignments: {
        "claude:/w/ok": "Work/Sub",
        "claude:/w/dangling": "Ghost",
        "claude:/w/bad": 7,
      },
      sessionGroups: { "claude:/w/p": ["Bugs", "", 3] },
      sessionAssignments: {
        "claude:sid-ok": "Bugs",
        "claude:sid-ghost": "Nope",
      },
    });
    expect(state.projectFolders).toEqual(["Work", "Work/Sub"]);
    expect(state.projectAssignments).toEqual({ "claude:/w/ok": "Work/Sub" });
    expect(state.sessionGroups).toEqual({ "claude:/w/p": ["Bugs"] });
    expect(state.sessionAssignments).toEqual({ "claude:sid-ok": "Bugs" });
  });

  it("tolerates garbage input", () => {
    expect(sanitizeFoldersState(null)).toEqual(emptyFoldersState());
    expect(sanitizeFoldersState("x")).toEqual(emptyFoldersState());
  });
});
