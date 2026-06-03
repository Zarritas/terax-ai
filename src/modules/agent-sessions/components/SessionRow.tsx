import { GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AgentProviderId, AgentSession } from "../lib/native";
import { formatBytes, formatRelativeTime, sessionLabel } from "../lib/parse";

const PROVIDER_CHIP: Record<AgentProviderId, string> = {
  claude: "text-orange-500 border-orange-500/30 bg-orange-500/10",
  codex: "text-emerald-500 border-emerald-500/30 bg-emerald-500/10",
  opencode: "text-sky-500 border-sky-500/30 bg-sky-500/10",
  gemini: "text-violet-500 border-violet-500/30 bg-violet-500/10",
};

type Props = {
  session: AgentSession;
  onResume: (session: AgentSession) => void;
};

export function SessionRow({ session, onResume }: Props) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onResume(session)}
          className={cn(
            "group flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
            "hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-primary/40",
          )}
        >
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex shrink-0 items-center rounded border px-1 text-[9px] font-semibold uppercase leading-4",
                PROVIDER_CHIP[session.provider] ?? PROVIDER_CHIP.claude,
              )}
            >
              {session.provider}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
              {sessionLabel(session)}
            </span>
            {session.isActive ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[9px] font-semibold uppercase leading-4 text-emerald-500">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                active
              </span>
            ) : null}
          </span>
          <span className="flex items-center gap-2 pl-0.5 text-[10px] text-muted-foreground">
            {session.branch ? (
              <span className="inline-flex min-w-0 items-center gap-0.5">
                <HugeiconsIcon
                  icon={GitBranchIcon}
                  size={10}
                  className="shrink-0"
                />
                <span className="truncate">{session.branch}</span>
              </span>
            ) : null}
            {session.messageCount !== null ? (
              <span className="shrink-0 tabular-nums">
                {session.messageCount} msgs
              </span>
            ) : null}
            {session.sizeBytes !== null ? (
              <span className="shrink-0 tabular-nums">
                {formatBytes(session.sizeBytes)}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 tabular-nums">
              {formatRelativeTime(session.lastActivity)}
            </span>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-80">
        <p className="break-all font-mono text-[10px]">{session.id}</p>
        {session.cwd ? (
          <p className="break-all text-[10px] text-muted-foreground">
            {session.cwd}
          </p>
        ) : null}
        <p className="text-[10px]">
          {session.isActive
            ? "Running — click to focus its tab (or get a notice if external)"
            : `Click to resume: ${session.resumeArgv.join(" ")}`}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
