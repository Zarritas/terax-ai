import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
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
import type { AgentSession } from "../lib/native";
import { groupByProject, matchesFilter } from "../lib/parse";
import type { AgentSessionsBridge } from "../lib/resume";
import { useAgentSessionsStore } from "../store/agentSessionsStore";
import { SessionRow } from "./SessionRow";

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

  const groups = useMemo(() => {
    const visible = sessions.filter((s: AgentSession) =>
      matchesFilter(s, filter),
    );
    return groupByProject(visible);
  }, [sessions, filter]);

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
          {!error && groups.length === 0 ? (
            <p className="px-2 py-2 text-[11px] text-muted-foreground">
              {sessions.length === 0
                ? "No agent sessions found. Sessions from Claude Code, Codex, OpenCode and Gemini will show up here."
                : "No sessions match the filter."}
            </p>
          ) : null}
          {groups.map((group) => {
            const key = group.cwd ?? "";
            const isCollapsed = collapsed.has(key);
            return (
              <div key={key} className="mb-0.5">
                <button
                  type="button"
                  onClick={() => toggleCollapsed(key)}
                  className="flex w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-foreground/[0.045]"
                  title={group.cwd ?? undefined}
                >
                  <HugeiconsIcon
                    icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                    size={12}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/90">
                    {group.name}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {group.sessions.length}
                  </span>
                </button>
                {!isCollapsed
                  ? group.sessions.map((session) => (
                      <SessionRow
                        key={`${session.provider}:${session.id}`}
                        session={session}
                        onResume={bridge.resumeSession}
                      />
                    ))
                  : null}
              </div>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}
