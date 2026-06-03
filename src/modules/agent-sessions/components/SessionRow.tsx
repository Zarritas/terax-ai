import { GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SessionMetadata } from "../lib/metadata";
import type { AgentSession } from "../lib/native";
import {
  colorClasses,
  formatBytes,
  formatRelativeTime,
  SESSION_COLORS,
  sessionLabel,
} from "../lib/parse";

export type RowAction =
  | { kind: "rename" }
  | { kind: "tags" }
  | { kind: "color"; token: string | null }
  | { kind: "preview" }
  | { kind: "delete" };

type Props = {
  session: AgentSession;
  meta?: SessionMetadata;
  onResume: (session: AgentSession) => void;
  onAction: (session: AgentSession, action: RowAction) => void;
};

export function SessionRow({ session, meta, onResume, onAction }: Props) {
  const color = colorClasses(meta?.color);
  const tags = meta?.tags ?? [];
  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onResume(session)}
              className={cn(
                "group flex w-full cursor-pointer items-stretch gap-1.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
                "hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-primary/40",
              )}
            >
              {color ? (
                <span
                  className={cn(
                    "w-0.5 shrink-0 self-stretch rounded-full",
                    color.bar,
                  )}
                />
              ) : null}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[12px] text-foreground/90",
                      color?.label,
                    )}
                  >
                    {sessionLabel(session, meta)}
                  </span>
                  {session.isActive ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[9px] font-semibold uppercase leading-4 text-emerald-500">
                      <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                      active
                    </span>
                  ) : null}
                </span>
                {tags.length ? (
                  <span className="flex flex-wrap items-center gap-1">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center rounded border border-cyan-500/30 bg-cyan-500/10 px-1 text-[9px] font-medium leading-4 text-cyan-500"
                      >
                        #{tag}
                      </span>
                    ))}
                  </span>
                ) : null}
                <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
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
              </span>
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
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
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onAction(session, { kind: "rename" })}>
          Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAction(session, { kind: "tags" })}>
          Edit tags
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Color</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <div className="grid grid-cols-4 gap-1 p-1">
              {SESSION_COLORS.map((c) => (
                <button
                  key={c.token}
                  type="button"
                  aria-label={`Color ${c.token}`}
                  onClick={() =>
                    onAction(session, { kind: "color", token: c.token })
                  }
                  className={cn(
                    "size-5 cursor-pointer rounded-full transition-transform hover:scale-110",
                    c.bar,
                    meta?.color === c.token && "ring-2 ring-foreground/60",
                  )}
                />
              ))}
            </div>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => onAction(session, { kind: "color", token: null })}
            >
              Clear color
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onAction(session, { kind: "preview" })}>
          Preview conversation
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={() => onAction(session, { kind: "delete" })}
        >
          {session.provider === "codex" ? "Archive" : "Delete"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
