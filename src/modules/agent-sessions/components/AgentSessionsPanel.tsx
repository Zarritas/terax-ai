import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  CleanIcon,
  Download01Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  open as openFileDialog,
  save as saveFileDialog,
} from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAgentSessions } from "../hooks/useAgentSessions";
import {
  allKnownTags,
  deleteMetadata,
  parseTagList,
  setMetadata,
} from "../lib/metadata";
import type { AgentProviderId, AgentSession } from "../lib/native";
import {
  deleteSession,
  exportSessions,
  importSessions,
  moveSession,
  previewSession,
  readManifest,
  searchSessions,
} from "../lib/native";
import {
  groupByProviderThenProject,
  matchesFilter,
  parseFilter,
  safeFilename,
  sessionLabel,
} from "../lib/parse";
import type { AgentSessionsBridge } from "../lib/resume";
import { useAgentSessionsStore } from "../store/agentSessionsStore";
import { CleanupDialog } from "./CleanupDialog";
import { type DialogState, SessionDialogs } from "./SessionDialogs";
import {
  type PreviewState,
  SessionPreviewDialog,
} from "./SessionPreviewDialog";
import { type RowAction, SessionRow } from "./SessionRow";
import { type TransferDialogState, TransferDialogs } from "./TransferDialogs";

const PROVIDER_LABEL: Record<AgentProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini",
};

const PROVIDER_ACCENT: Record<AgentProviderId, string> = {
  claude: "text-orange-500",
  codex: "text-emerald-500",
  opencode: "text-sky-500",
  gemini: "text-violet-500",
};

type Props = {
  bridge: AgentSessionsBridge;
  home: string | null;
  /** Cwd used for "new session" started from the header. */
  workspaceCwd: string | null;
};

export function AgentSessionsPanel({ bridge, home, workspaceCwd }: Props) {
  const { refresh } = useAgentSessions(home);
  const providers = useAgentSessionsStore((s) => s.providers);
  const sessions = useAgentSessionsStore((s) => s.sessions);
  const filter = useAgentSessionsStore((s) => s.filter);
  const loading = useAgentSessionsStore((s) => s.loading);
  const error = useAgentSessionsStore((s) => s.error);
  const collapsed = useAgentSessionsStore((s) => s.collapsed);
  const setFilter = useAgentSessionsStore((s) => s.setFilter);
  const toggleCollapsed = useAgentSessionsStore((s) => s.toggleCollapsed);

  const metadata = useAgentSessionsStore((s) => s.metadata);
  const updateMetadata = useAgentSessionsStore((s) => s.updateMetadata);
  const searchIds = useAgentSessionsStore((s) => s.searchIds);
  const setSearchIds = useAgentSessionsStore((s) => s.setSearchIds);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [preview, setPreview] = useState<PreviewState>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [transferDialog, setTransferDialog] =
    useState<TransferDialogState>(null);

  const claudeCwds = useMemo(() => {
    const cwds = new Set<string>();
    for (const s of sessions) {
      if (s.provider === "claude" && s.cwd) cwds.add(s.cwd);
    }
    return [...cwds].sort();
  }, [sessions]);

  const handleExport = useCallback(
    (targets: AgentSession[], defaultStem: string) => {
      void (async () => {
        const destPath = await saveFileDialog({
          defaultPath: `${safeFilename(defaultStem)}.claude-session.zip`,
          filters: [{ name: "Claude session archive", extensions: ["zip"] }],
        });
        if (!destPath) return;
        try {
          const items = targets.map((s) => {
            const meta = metadata[`${s.provider}:${s.id}`];
            return {
              sessionId: s.id,
              displayName: meta?.name ?? null,
              tags: meta?.tags ?? [],
            };
          });
          const written = await exportSessions(items, destPath);
          toast.success(`Exported ${written} session(s)`);
        } catch (err) {
          toast.error(String(err));
        }
      })();
    },
    [metadata],
  );

  const handleImportClick = useCallback(() => {
    void (async () => {
      const zipPath = await openFileDialog({
        multiple: false,
        filters: [{ name: "Session archive", extensions: ["zip"] }],
      });
      if (typeof zipPath !== "string") return;
      try {
        const manifest = await readManifest(zipPath);
        setTransferDialog({ kind: "import", zipPath, manifest });
      } catch (err) {
        toast.error(String(err));
      }
    })();
  }, []);

  const handleImport = useCallback(
    (zipPath: string, destCwd: string) => {
      void (async () => {
        try {
          const outcome = await importSessions(zipPath, destCwd);
          for (const imported of outcome.imported) {
            if (imported.displayName || imported.tags.length) {
              const next = await setMetadata("claude", imported.id, {
                name: imported.displayName ?? undefined,
                tags: imported.tags.length ? imported.tags : undefined,
              });
              updateMetadata("claude", imported.id, next);
            }
          }
          const parts = [`Imported ${outcome.imported.length}`];
          if (outcome.skippedExisting.length)
            parts.push(`${outcome.skippedExisting.length} already present`);
          if (outcome.skippedMissing.length)
            parts.push(`${outcome.skippedMissing.length} missing payload`);
          toast[outcome.imported.length ? "success" : "warning"](
            parts.join(" · "),
          );
          void refresh(true);
        } catch (err) {
          toast.error(String(err));
        }
      })();
    },
    [updateMetadata, refresh],
  );

  const handleMove = useCallback(
    (session: AgentSession, destCwd: string) => {
      void (async () => {
        try {
          await moveSession(session.id, session.cwd ?? "", destCwd);
          toast.success("Session moved");
          void refresh(true);
        } catch (err) {
          const msg = String(err);
          if (msg.includes("ACTIVE")) {
            toast.error("The session is running — close it before moving");
          } else if (msg.includes("COLLISION")) {
            toast.error("The destination already has a session with this id");
          } else {
            toast.error(msg);
          }
        }
      })();
    },
    [refresh],
  );

  const contentQuery = useMemo(() => parseFilter(filter).content, [filter]);

  // content: terms resolve against the FTS index, debounced; the result set
  // intersects with the structured/free-text filtering below.
  useEffect(() => {
    if (!contentQuery) {
      setSearchIds(null);
      return;
    }
    const timer = window.setTimeout(() => {
      searchSessions(contentQuery)
        .then((refs) =>
          setSearchIds(
            new Set(refs.map((r) => `${r.provider}:${r.sessionId}`)),
          ),
        )
        .catch(() => setSearchIds(new Set()));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [contentQuery, setSearchIds]);

  const openPreview = useCallback((session: AgentSession) => {
    setPreview({ session, turns: null, error: null });
    previewSession(session.provider, session.id)
      .then((turns) =>
        setPreview((current) =>
          current?.session.id === session.id
            ? { session, turns, error: null }
            : current,
        ),
      )
      .catch((err) =>
        setPreview((current) =>
          current?.session.id === session.id
            ? { session, turns: [], error: String(err) }
            : current,
        ),
      );
  }, []);

  const handleCleanup = useCallback(
    (targets: AgentSession[]) => {
      void (async () => {
        let deleted = 0;
        let failed = 0;
        for (const session of targets) {
          try {
            await deleteSession(session.provider, session.id, false);
            await deleteMetadata(session.provider, session.id).catch(() => {});
            updateMetadata(session.provider, session.id, null);
            deleted += 1;
          } catch {
            failed += 1;
          }
        }
        toast[failed ? "warning" : "success"](
          `Removed ${deleted} session(s)` +
            (failed ? `, ${failed} failed` : ""),
        );
        void refresh(true);
      })();
    },
    [updateMetadata, refresh],
  );

  const persistMeta = useCallback(
    (session: AgentSession, patch: Parameters<typeof setMetadata>[2]) => {
      void setMetadata(session.provider, session.id, patch)
        .then((next) => updateMetadata(session.provider, session.id, next))
        .catch(() => toast.error("Could not save session metadata"));
    },
    [updateMetadata],
  );

  const handleDelete = useCallback(
    (session: AgentSession, force: boolean) => {
      deleteSession(session.provider, session.id, force)
        .then(() => {
          void deleteMetadata(session.provider, session.id).catch(() => {});
          updateMetadata(session.provider, session.id, null);
          toast.success(
            session.provider === "codex"
              ? "Session archived"
              : "Session deleted",
          );
          void refresh(true);
        })
        .catch((err) => {
          if (String(err).includes("ACTIVE")) {
            setDialog({ kind: "force-delete", session });
          } else {
            toast.error(String(err));
          }
        });
    },
    [updateMetadata, refresh],
  );

  const handleRowAction = useCallback(
    (session: AgentSession, action: RowAction) => {
      switch (action.kind) {
        case "rename":
          setDialog({ kind: "rename", session });
          break;
        case "tags":
          setDialog({ kind: "tags", session });
          break;
        case "color":
          persistMeta(session, { color: action.token ?? undefined });
          break;
        case "preview":
          openPreview(session);
          break;
        case "export":
          handleExport(
            [session],
            sessionLabel(
              session,
              metadata[`${session.provider}:${session.id}`],
            ),
          );
          break;
        case "move":
          setTransferDialog({ kind: "move", session });
          break;
        case "delete":
          setDialog({ kind: "delete", session });
          break;
      }
    },
    [persistMeta, openPreview, handleExport, metadata],
  );

  const providerGroups = useMemo(() => {
    const parsed = parseFilter(filter);
    const visible = sessions.filter(
      (s: AgentSession) =>
        (searchIds === null || searchIds.has(`${s.provider}:${s.id}`)) &&
        matchesFilter(s, parsed, metadata[`${s.provider}:${s.id}`]),
    );
    return groupByProviderThenProject(visible);
  }, [sessions, filter, metadata, searchIds]);

  const startable = providers.filter((p) => p.binaryFound);
  const activeCount = sessions.filter((s) => s.isActive).length;

  return (
    <TooltipProvider delayDuration={350}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Agent Sessions
          </span>
          {activeCount > 0 ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1 text-[9px] font-semibold tabular-nums text-emerald-500">
              {activeCount}
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-0.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="New agent session"
                  disabled={startable.length === 0}
                  className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-default disabled:opacity-40"
                >
                  <HugeiconsIcon icon={Add01Icon} size={13} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {startable.map((provider) => (
                  <DropdownMenuItem
                    key={provider.id}
                    onSelect={() => bridge.newSession(provider, workspaceCwd)}
                  >
                    New {provider.displayName} session
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              aria-label="Import sessions from archive"
              onClick={handleImportClick}
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <HugeiconsIcon icon={Download01Icon} size={13} />
            </button>
            <button
              type="button"
              aria-label="Clean up old sessions"
              onClick={() => setCleanupOpen(true)}
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <HugeiconsIcon icon={CleanIcon} size={13} />
            </button>
            <button
              type="button"
              aria-label="Refresh sessions"
              onClick={() => void refresh(true)}
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <HugeiconsIcon
                icon={Refresh01Icon}
                size={13}
                className={cn(loading && "animate-spin")}
              />
            </button>
          </span>
        </div>

        <div className="shrink-0 px-2 pb-1.5">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…  (tag: branch: id: path: content:)"
            className="h-7 text-[12px]"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {error ? (
            <p className="px-2 py-2 text-[11px] text-destructive">{error}</p>
          ) : null}
          {!error && providerGroups.length === 0 ? (
            <p className="px-2 py-2 text-[11px] text-muted-foreground">
              {sessions.length === 0
                ? "No agent sessions found. Sessions from Claude Code, Codex, OpenCode and Gemini will show up here."
                : "No sessions match the filter."}
            </p>
          ) : null}
          {providerGroups.map((group) => {
            const providerKey = `provider:${group.provider}`;
            const providerCollapsed = collapsed.has(providerKey);
            return (
              <div key={group.provider} className="mb-1">
                <button
                  type="button"
                  onClick={() => toggleCollapsed(providerKey)}
                  className="flex w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-foreground/[0.045]"
                >
                  <HugeiconsIcon
                    icon={
                      providerCollapsed ? ArrowRight01Icon : ArrowDown01Icon
                    }
                    size={12}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide",
                      PROVIDER_ACCENT[group.provider] ?? "text-foreground/90",
                    )}
                  >
                    {PROVIDER_LABEL[group.provider] ?? group.provider}
                  </span>
                  {group.activeCount > 0 ? (
                    <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1 text-[9px] font-semibold tabular-nums text-emerald-500">
                      {group.activeCount}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {group.sessionCount}
                  </span>
                </button>
                {!providerCollapsed
                  ? group.projects.map((project) => {
                      const projectKey = `${group.provider}:${project.cwd ?? ""}`;
                      const projectCollapsed = collapsed.has(projectKey);
                      return (
                        <div key={projectKey} className="mb-0.5 pl-2">
                          <button
                            type="button"
                            onClick={() => toggleCollapsed(projectKey)}
                            className="flex w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-foreground/[0.045]"
                            title={project.cwd ?? undefined}
                          >
                            <HugeiconsIcon
                              icon={
                                projectCollapsed
                                  ? ArrowRight01Icon
                                  : ArrowDown01Icon
                              }
                              size={11}
                              className="shrink-0 text-muted-foreground"
                            />
                            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/90">
                              {project.name}
                            </span>
                            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                              {project.sessions.length}
                            </span>
                          </button>
                          {!projectCollapsed
                            ? project.sessions.map((session) => (
                                <SessionRow
                                  key={`${session.provider}:${session.id}`}
                                  session={session}
                                  meta={
                                    metadata[
                                      `${session.provider}:${session.id}`
                                    ]
                                  }
                                  onResume={bridge.resumeSession}
                                  onAction={handleRowAction}
                                />
                              ))
                            : null}
                        </div>
                      );
                    })
                  : null}
              </div>
            );
          })}
        </div>
        <SessionPreviewDialog
          preview={preview}
          metadata={metadata}
          onClose={() => setPreview(null)}
        />
        <TransferDialogs
          dialog={transferDialog}
          metadata={metadata}
          claudeCwds={claudeCwds}
          onClose={() => setTransferDialog(null)}
          onMove={handleMove}
          onImport={handleImport}
        />
        <CleanupDialog
          open={cleanupOpen}
          sessions={sessions}
          onClose={() => setCleanupOpen(false)}
          onConfirm={handleCleanup}
        />
        <SessionDialogs
          dialog={dialog}
          metadata={metadata}
          knownTags={allKnownTags(metadata)}
          onClose={() => setDialog(null)}
          onRename={(session, name) =>
            persistMeta(session, { name: name.trim() || undefined })
          }
          onTags={(session, raw) =>
            persistMeta(session, { tags: parseTagList(raw) })
          }
          onDelete={handleDelete}
        />
      </div>
    </TooltipProvider>
  );
}
