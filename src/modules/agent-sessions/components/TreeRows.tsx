import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Folder01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { SessionMetadata } from "../lib/metadata";
import type { AgentSession } from "../lib/native";
import type { FolderNode, ProjectNode } from "../lib/parse";
import { type RowAction, SessionRow } from "./SessionRow";

export type TreeCallbacks = {
  collapsed: Set<string>;
  toggleCollapsed: (key: string) => void;
  metadata: Record<string, SessionMetadata>;
  onResume: (session: AgentSession) => void;
  onRowAction: (session: AgentSession, action: RowAction) => void;
  onMoveProjectToFolder: (provider: string, cwd: string) => void;
  onNewGroup: (provider: string, cwd: string) => void;
  onRenameFolder: (path: string) => void;
  onDeleteFolder: (path: string) => void;
  onRenameGroup: (provider: string, cwd: string, name: string) => void;
  onDeleteGroup: (provider: string, cwd: string, name: string) => void;
};

const ROW_BTN =
  "flex w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-foreground/[0.045]";

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <HugeiconsIcon
      icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
      size={11}
      className="shrink-0 text-muted-foreground"
    />
  );
}

export function ProjectBlock({
  provider,
  project,
  cb,
  indent = 0,
}: {
  provider: string;
  project: ProjectNode;
  cb: TreeCallbacks;
  indent?: number;
}) {
  const projectCwd = project.cwd ?? "";
  const projectCollapseKey = `${provider}:${projectCwd}`;
  const projectCollapsed = cb.collapsed.has(projectCollapseKey);
  return (
    <div className="mb-0.5" style={{ paddingLeft: indent ? indent * 10 : 0 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => cb.toggleCollapsed(projectCollapseKey)}
            className={ROW_BTN}
            title={project.cwd ?? undefined}
          >
            <Chevron collapsed={projectCollapsed} />
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/90">
              {project.name}
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {project.sessions.length}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => cb.onMoveProjectToFolder(provider, projectCwd)}
          >
            Move to folder…
          </ContextMenuItem>
          <ContextMenuItem onClick={() => cb.onNewGroup(provider, projectCwd)}>
            New session group…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {!projectCollapsed ? (
        <div className="pl-2">
          {project.groups.map((group) => {
            const groupKey = `sgroup:${provider}:${projectCwd}:${group.name}`;
            const groupCollapsed = cb.collapsed.has(groupKey);
            return (
              <div key={group.name} className="mb-0.5">
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={() => cb.toggleCollapsed(groupKey)}
                      className={ROW_BTN}
                    >
                      <Chevron collapsed={groupCollapsed} />
                      <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/75 italic">
                        {group.name}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {group.sessions.length}
                      </span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem
                      onClick={() =>
                        cb.onRenameGroup(provider, projectCwd, group.name)
                      }
                    >
                      Rename group
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      onClick={() =>
                        cb.onDeleteGroup(provider, projectCwd, group.name)
                      }
                    >
                      Delete group
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
                {!groupCollapsed
                  ? group.sessions.map((session) => (
                      <div key={session.id} className="pl-2">
                        <SessionRow
                          session={session}
                          meta={
                            cb.metadata[`${session.provider}:${session.id}`]
                          }
                          onResume={cb.onResume}
                          onAction={cb.onRowAction}
                        />
                      </div>
                    ))
                  : null}
              </div>
            );
          })}
          {project.looseSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              meta={cb.metadata[`${session.provider}:${session.id}`]}
              onResume={cb.onResume}
              onAction={cb.onRowAction}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FolderBlock({
  provider,
  node,
  cb,
}: {
  provider: string;
  node: FolderNode;
  cb: TreeCallbacks;
}) {
  const collapseKey = `folder:${provider}:${node.path}`;
  const isCollapsed = cb.collapsed.has(collapseKey);
  return (
    <div className="mb-0.5" style={{ paddingLeft: node.depth ? 10 : 0 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => cb.toggleCollapsed(collapseKey)}
            className={ROW_BTN}
            title={node.path}
          >
            <Chevron collapsed={isCollapsed} />
            <HugeiconsIcon
              icon={Folder01Icon}
              size={12}
              className="shrink-0 text-amber-500/80"
            />
            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground/90">
              {node.name}
            </span>
            {node.workingCount > 0 ? (
              <span
                className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center gap-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1 text-[9px] font-semibold tabular-nums text-emerald-500"
                title={`${node.workingCount} session(s) working`}
              >
                <span className="size-1 animate-pulse rounded-full bg-emerald-500" />
                {node.workingCount}
              </span>
            ) : null}
            {node.waitingCount > 0 ? (
              <span
                className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center gap-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-1 text-[9px] font-semibold tabular-nums text-amber-500"
                title={`${node.waitingCount} session(s) waiting for input`}
              >
                <span className="size-1 rounded-full bg-amber-500" />
                {node.waitingCount}
              </span>
            ) : null}
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {node.sessionCount}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => cb.onRenameFolder(node.path)}>
            Rename folder
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onClick={() => cb.onDeleteFolder(node.path)}
          >
            Delete folder
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {!isCollapsed ? (
        <div className="pl-1.5">
          {node.children.map((child) => (
            <FolderBlock
              key={child.path}
              provider={provider}
              node={child}
              cb={cb}
            />
          ))}
          {node.projects.map((project) => (
            <ProjectBlock
              key={project.cwd ?? ""}
              provider={provider}
              project={project}
              cb={cb}
              indent={1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
