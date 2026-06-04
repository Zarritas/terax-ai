import { useState } from "react";
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
import type { SessionMetadata } from "../lib/metadata";
import type { AgentSession, ManifestSessionInfo } from "../lib/native";
import { sessionLabel } from "../lib/parse";
import { CwdPicker } from "./CwdPicker";

export type TransferDialogState =
  | { kind: "move"; session: AgentSession }
  | { kind: "import"; zipPath: string; manifest: ManifestSessionInfo[] }
  | null;

type Props = {
  dialog: TransferDialogState;
  metadata: Record<string, SessionMetadata>;
  /** Existing Claude project cwds, candidates for move/import targets. */
  claudeCwds: string[];
  onClose: () => void;
  onMove: (session: AgentSession, destCwd: string) => void;
  onImport: (zipPath: string, destCwd: string) => void;
};

export function TransferDialogs({
  dialog,
  metadata,
  claudeCwds,
  onClose,
  onMove,
  onImport,
}: Props) {
  const [dest, setDest] = useState<string | null>(null);
  if (!dialog) return null;

  const close = () => {
    setDest(null);
    onClose();
  };

  if (dialog.kind === "move") {
    const { session } = dialog;
    const meta = metadata[`${session.provider}:${session.id}`];
    const candidates = claudeCwds.filter((cwd) => cwd !== session.cwd);
    return (
      <AlertDialog open onOpenChange={(o) => !o && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="truncate">
              Move "{sessionLabel(session, meta)}"
            </AlertDialogTitle>
            <AlertDialogDescription>
              The session log relocates to the chosen project and Claude will
              resume it under that directory. Running sessions can't be moved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <CwdPicker
            cwds={candidates}
            selected={dest}
            onSelect={setDest}
            emptyText="No other Claude projects found."
          />
          <AlertDialogFooter>
            <AlertDialogCancel onClick={close}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!dest}
              onClick={() => {
                if (dest) onMove(session, dest);
                close();
              }}
            >
              Move
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  const { zipPath, manifest } = dialog;
  return (
    <AlertDialog open onOpenChange={(o) => !o && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Import sessions</AlertDialogTitle>
          <AlertDialogDescription>
            {manifest.length} session(s) in the archive. Existing ids are never
            overwritten; names and tags are restored.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto text-[11px] text-muted-foreground">
          {manifest.slice(0, 5).map((m) => (
            <li key={m.id} className="truncate">
              · {m.displayName ?? m.firstPrompt ?? m.id}
            </li>
          ))}
          {manifest.length > 5 ? (
            <li>… and {manifest.length - 5} more</li>
          ) : null}
        </ul>
        <p className="text-[11px] font-medium text-foreground/80">
          Import into project:
        </p>
        <CwdPicker
          cwds={claudeCwds}
          selected={dest}
          onSelect={setDest}
          emptyText="No other Claude projects found."
        />
        <AlertDialogFooter>
          <AlertDialogCancel onClick={close}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!dest}
            onClick={() => {
              if (dest) onImport(zipPath, dest);
              close();
            }}
          >
            Import
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
