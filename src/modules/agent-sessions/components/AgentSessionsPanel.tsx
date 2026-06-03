import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useMemo, useState } from "react";
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
import { deleteSession } from "../lib/native";
import {
  groupByProviderThenProject,
  matchesFilter,
  parseFilter,
} from "../lib/parse";
import type { AgentSessionsBridge } from "../lib/resume";
import { useAgentSessionsStore } from "../store/agentSessionsStore";
import { type DialogState, SessionDialogs } from "./SessionDialogs";
import { type RowAction, SessionRow } from "./SessionRow";

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
  const [dialog, setDialog] = useState<DialogState>(null);

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
          // Wired in the preview commit.
          break;
        case "delete":
          setDialog({ kind: "delete", session });
          break;
      }
    },
    [persistMeta],
  );

  const providerGroups = useMemo(() => {
    const parsed = parseFilter(filter);
    const visible = sessions.filter((s: AgentSession) =>
      matchesFilter(s, parsed, metadata[`${s.provider}:${s.id}`]),
    );
    return groupByProviderThenProject(visible);
  }, [sessions, filter, metadata]);

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
            placeholder="Filter sessions…"
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
