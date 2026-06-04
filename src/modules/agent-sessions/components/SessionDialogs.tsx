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
import type { SessionMetadata } from "../lib/metadata";
import type { AgentSession } from "../lib/native";
import { sessionLabel } from "../lib/parse";

export type DialogState =
  | { kind: "rename"; session: AgentSession }
  | { kind: "tags"; session: AgentSession }
  | { kind: "delete"; session: AgentSession }
  | { kind: "force-delete"; session: AgentSession }
  | null;

type Props = {
  dialog: DialogState;
  metadata: Record<string, SessionMetadata>;
  knownTags: string[];
  onClose: () => void;
  onRename: (session: AgentSession, name: string) => void;
  onTags: (session: AgentSession, raw: string) => void;
  onDelete: (session: AgentSession, force: boolean) => void;
};

const DELETE_COPY: Record<string, string> = {
  claude:
    "This permanently deletes the session log (and its subagent data) from disk. It cannot be undone.",
  codex:
    "The rollout is moved to Codex's archived_sessions and disappears from the list. Recoverable with `codex unarchive`.",
  gemini:
    "This permanently deletes the chat file from disk. It cannot be undone.",
  opencode:
    "The session is deleted through OpenCode's own CLI and removed from its database.",
};

export function SessionDialogs({
  dialog,
  metadata,
  knownTags,
  onClose,
  onRename,
  onTags,
  onDelete,
}: Props) {
  const session = dialog?.session ?? null;
  const meta = session
    ? metadata[`${session.provider}:${session.id}`]
    : undefined;
  const [value, setValue] = useState("");

  // Prefill the input when a text dialog opens.
  useEffect(() => {
    if (!dialog || !session) return;
    if (dialog.kind === "rename") {
      setValue(meta?.name ?? session.title ?? "");
    } else if (dialog.kind === "tags") {
      setValue((meta?.tags ?? []).join(", "));
    }
  }, [dialog, session, meta]);

  if (!dialog || !session) return null;

  if (dialog.kind === "rename" || dialog.kind === "tags") {
    const isRename = dialog.kind === "rename";
    const submit = () => {
      if (isRename) onRename(session, value);
      else onTags(session, value);
      onClose();
    };
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {isRename ? "Rename session" : "Edit tags"}
            </DialogTitle>
          </DialogHeader>
          <p className="break-all font-mono text-[10px] text-muted-foreground">
            {session.provider} · {session.id}
          </p>
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              isRename ? "Display name (empty to clear)" : "tag1, tag2 …"
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          {!isRename && knownTags.length ? (
            <div className="flex flex-wrap gap-1">
              {knownTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() =>
                    setValue((v) => (v.trim() ? `${v.trim()}, ${tag}` : tag))
                  }
                  className="inline-flex cursor-pointer items-center rounded border border-cyan-500/30 bg-cyan-500/10 px-1 text-[10px] text-cyan-500 hover:bg-cyan-500/20"
                >
                  #{tag}
                </button>
              ))}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const force = dialog.kind === "force-delete";
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {force
              ? "Session is running — force delete?"
              : session.provider === "codex"
                ? `Archive "${sessionLabel(session, meta)}"?`
                : `Delete "${sessionLabel(session, meta)}"?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {force
              ? "This session is live in another terminal. Deleting its log under a running process can corrupt it. Force delete anyway?"
              : (DELETE_COPY[session.provider] ?? DELETE_COPY.claude)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              onDelete(session, force);
              onClose();
            }}
          >
            {force
              ? "Force delete"
              : session.provider === "codex"
                ? "Archive"
                : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
