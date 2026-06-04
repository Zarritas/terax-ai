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
import { cn } from "@/lib/utils";
import type { SessionMetadata } from "../lib/metadata";
import type { AgentSession, ManifestSessionInfo } from "../lib/native";
import { sessionLabel } from "../lib/parse";

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

function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

function CwdPicker({
  cwds,
  selected,
  onSelect,
}: {
  cwds: string[];
  selected: string | null;
  onSelect: (cwd: string) => void;
}) {
  return (
    <div className="max-h-56 overflow-y-auto rounded-md border border-border/60 p-1">
      <div className="flex flex-col gap-0.5">
        {cwds.map((cwd) => {
          const isSelected = cwd === selected;
          return (
            <button
              key={cwd}
              type="button"
              onClick={() => onSelect(cwd)}
              className={cn(
                // shrink-0: flex children otherwise compress to fit the
                // scroll container and rows render clipped.
                "flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                isSelected
                  ? "bg-primary/10 ring-1 ring-primary/40"
                  : "hover:bg-foreground/[0.05]",
              )}
              title={cwd}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  isSelected ? "bg-primary" : "bg-foreground/15",
                )}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate text-[12px] font-medium",
                    isSelected ? "text-foreground" : "text-foreground/85",
                  )}
                >
                  {projectName(cwd)}
                </span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {cwd}
                </span>
              </span>
            </button>
          );
        })}
        {cwds.length === 0 ? (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">
            No other Claude projects found.
          </p>
        ) : null}
      </div>
    </div>
  );
}

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
          <CwdPicker cwds={candidates} selected={dest} onSelect={setDest} />
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
        <CwdPicker cwds={claudeCwds} selected={dest} onSelect={setDest} />
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
