import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  FOLDER_SEPARATOR,
  type FoldersState,
  folderLeaf,
  folderOfProject,
  projectKey,
  sessionKey,
} from "../lib/folders";
import type { AgentSession } from "../lib/native";

export type FolderDialogState =
  | { kind: "move-to-folder"; provider: string; cwd: string }
  | { kind: "new-group"; provider: string; cwd: string }
  | { kind: "rename-folder"; path: string }
  | { kind: "delete-folder"; path: string }
  | { kind: "rename-group"; provider: string; cwd: string; name: string }
  | { kind: "delete-group"; provider: string; cwd: string; name: string }
  | { kind: "move-to-group"; session: AgentSession }
  | null;

type Props = {
  dialog: FolderDialogState;
  folders: FoldersState;
  onClose: () => void;
  onAssignFolder: (provider: string, cwd: string, path: string | null) => void;
  onRenameFolder: (path: string, newLeaf: string) => void;
  onDeleteFolder: (path: string) => void;
  onCreateGroup: (provider: string, cwd: string, name: string) => void;
  onRenameGroup: (
    provider: string,
    cwd: string,
    oldName: string,
    newName: string,
  ) => void;
  onDeleteGroup: (provider: string, cwd: string, name: string) => void;
  onAssignGroup: (session: AgentSession, group: string | null) => void;
};

export function FolderDialogs({
  dialog,
  folders,
  onClose,
  onAssignFolder,
  onRenameFolder,
  onDeleteFolder,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onAssignGroup,
}: Props) {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!dialog) return;
    if (dialog.kind === "rename-folder") setValue(folderLeaf(dialog.path));
    else if (dialog.kind === "rename-group") setValue(dialog.name);
    else if (dialog.kind === "move-to-folder") {
      setValue(
        folderOfProject(folders, projectKey(dialog.provider, dialog.cwd)) ?? "",
      );
    } else setValue("");
  }, [dialog, folders]);

  if (!dialog) return null;

  // ---- destructive confirmations -----------------------------------------
  if (dialog.kind === "delete-folder" || dialog.kind === "delete-group") {
    const isFolder = dialog.kind === "delete-folder";
    return (
      <AlertDialog open onOpenChange={(o) => !o && onClose()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isFolder
                ? `Delete folder "${dialog.path}"?`
                : `Delete group "${dialog.name}"?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isFolder
                ? "Subfolders are deleted too. Projects inside are not touched — they return to the root of their provider."
                : "Sessions in the group are not touched — they return to the project."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onClose}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (isFolder) onDeleteFolder(dialog.path);
                else onDeleteGroup(dialog.provider, dialog.cwd, dialog.name);
                onClose();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  // ---- move session to group ----------------------------------------------
  if (dialog.kind === "move-to-group") {
    const { session } = dialog;
    const projKey = projectKey(session.provider, session.cwd ?? "");
    const groups = folders.sessionGroups[projKey] ?? [];
    const current =
      folders.sessionAssignments[sessionKey(session.provider, session.id)];
    const submit = (group: string | null) => {
      onAssignGroup(session, group);
      onClose();
    };
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Move to group</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-0.5">
            {groups.map((group) => (
              <button
                key={group}
                type="button"
                onClick={() => submit(group)}
                className={cn(
                  "cursor-pointer rounded px-2 py-1 text-left text-[12px] transition-colors hover:bg-foreground/[0.05]",
                  group === current && "bg-primary/10 ring-1 ring-primary/40",
                )}
              >
                {group}
              </button>
            ))}
          </div>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="New group name…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && value.trim()) submit(value);
            }}
          />
          <DialogFooter className="gap-2">
            {current ? (
              <Button variant="outline" size="sm" onClick={() => submit(null)}>
                Remove from group
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!value.trim()}
              onClick={() => submit(value)}
            >
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ---- text dialogs ---------------------------------------------------------
  const isMoveToFolder = dialog.kind === "move-to-folder";
  const title =
    dialog.kind === "move-to-folder"
      ? "Move project to folder"
      : dialog.kind === "new-group"
        ? "New session group"
        : dialog.kind === "rename-folder"
          ? "Rename folder"
          : "Rename group";
  const currentFolder = isMoveToFolder
    ? folderOfProject(folders, projectKey(dialog.provider, dialog.cwd))
    : null;

  const submit = () => {
    const trimmed = value.trim();
    switch (dialog.kind) {
      case "move-to-folder":
        if (trimmed) onAssignFolder(dialog.provider, dialog.cwd, trimmed);
        break;
      case "new-group":
        if (trimmed) onCreateGroup(dialog.provider, dialog.cwd, trimmed);
        break;
      case "rename-folder":
        if (trimmed) onRenameFolder(dialog.path, trimmed);
        break;
      case "rename-group":
        if (trimmed)
          onRenameGroup(dialog.provider, dialog.cwd, dialog.name, trimmed);
        break;
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            isMoveToFolder
              ? "Folder (use / to nest: Work/Client A)"
              : dialog.kind === "rename-folder"
                ? "New name (no /)"
                : "Name"
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        {isMoveToFolder && folders.projectFolders.length ? (
          <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
            {folders.projectFolders.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => setValue(path)}
                className={cn(
                  "shrink-0 cursor-pointer truncate rounded px-2 py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground",
                  path === value && "bg-primary/10 text-foreground",
                )}
                style={{
                  paddingLeft: `${8 + (path.split(FOLDER_SEPARATOR).length - 1) * 12}px`,
                }}
              >
                {folderLeaf(path)}
              </button>
            ))}
          </div>
        ) : null}
        <DialogFooter className="gap-2">
          {isMoveToFolder && currentFolder ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onAssignFolder(dialog.provider, dialog.cwd, null);
                onClose();
              }}
            >
              Remove from folder
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!value.trim()} onClick={submit}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
