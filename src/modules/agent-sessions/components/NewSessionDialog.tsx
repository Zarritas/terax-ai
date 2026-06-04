import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useMemo, useState } from "react";
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
import type { AgentProviderInfo } from "../lib/native";
import { CwdPicker } from "./CwdPicker";

type Props = {
  /** Provider chosen in the header dropdown; null keeps the dialog closed. */
  provider: AgentProviderInfo | null;
  /** Known project cwds across every provider, candidates for the picker. */
  cwds: string[];
  /** Default selection: the workspace currently open in Terax. */
  workspaceCwd: string | null;
  onClose: () => void;
  onCreate: (provider: AgentProviderInfo, cwd: string) => void;
};

export function NewSessionDialog({
  provider,
  cwds,
  workspaceCwd,
  onClose,
  onCreate,
}: Props) {
  // null means "no explicit choice yet" so the workspace default tracks prop
  // changes between opens instead of freezing at mount time.
  const [dest, setDest] = useState<string | null>(null);
  const [browsed, setBrowsed] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const cwd of [workspaceCwd, browsed, ...cwds]) {
      if (cwd && !seen.has(cwd)) {
        seen.add(cwd);
        out.push(cwd);
      }
    }
    return out;
  }, [workspaceCwd, browsed, cwds]);

  if (!provider) return null;
  const selected = dest ?? workspaceCwd;

  const close = () => {
    setDest(null);
    setBrowsed(null);
    onClose();
  };

  const browse = () => {
    void (async () => {
      const dir = await openFileDialog({
        directory: true,
        defaultPath: selected ?? undefined,
      });
      if (typeof dir !== "string") return;
      setBrowsed(dir);
      setDest(dir);
    })();
  };

  return (
    <AlertDialog open onOpenChange={(o) => !o && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            New {provider.displayName} session
          </AlertDialogTitle>
          <AlertDialogDescription>
            Choose the project the session starts in. The agent runs with this
            directory as its working directory.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <CwdPicker cwds={candidates} selected={selected} onSelect={setDest} />
        <button
          type="button"
          onClick={browse}
          className="self-start cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          Browse for another folder…
        </button>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={close}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!selected}
            onClick={() => {
              if (selected) onCreate(provider, selected);
              close();
            }}
          >
            Start session
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
