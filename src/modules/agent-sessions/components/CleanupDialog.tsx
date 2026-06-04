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
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AgentSession } from "../lib/native";

const PRESETS: Array<{ label: string; days: number | null }> = [
  { label: "Older than 1 week", days: 7 },
  { label: "Older than 1 month", days: 30 },
  { label: "Older than 3 months", days: 90 },
  { label: "Older than 6 months", days: 180 },
  { label: "Older than 1 year", days: 365 },
  { label: "Custom date", days: null },
];

/** Sessions eligible for bulk deletion: older than the threshold, not
 * running, and not opencode (its deletes go through a slow CLI; bulk would
 * stack subprocesses — delete those individually). */
export function cleanupCandidates(
  sessions: AgentSession[],
  thresholdSecs: number,
): AgentSession[] {
  return sessions.filter(
    (s) =>
      s.lastActivity < thresholdSecs &&
      !s.isActive &&
      s.provider !== "opencode",
  );
}

function parseIsoDate(raw: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = Date.parse(`${raw}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms / 1000;
}

type Props = {
  open: boolean;
  sessions: AgentSession[];
  onClose: () => void;
  onConfirm: (targets: AgentSession[]) => void;
};

export function CleanupDialog({ open, sessions, onClose, onConfirm }: Props) {
  const [presetIdx, setPresetIdx] = useState(1); // default: 1 month
  const [customDate, setCustomDate] = useState("");

  const threshold = useMemo(() => {
    const preset = PRESETS[presetIdx];
    if (preset.days !== null) {
      return Date.now() / 1000 - preset.days * 86_400;
    }
    return parseIsoDate(customDate);
  }, [presetIdx, customDate]);

  const targets = useMemo(
    () => (threshold !== null ? cleanupCandidates(sessions, threshold) : []),
    [sessions, threshold],
  );
  const skippedActive = useMemo(
    () =>
      threshold !== null
        ? sessions.filter((s) => s.lastActivity < threshold && s.isActive)
            .length
        : 0,
    [sessions, threshold],
  );

  if (!open) return null;
  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clean up old sessions</AlertDialogTitle>
          <AlertDialogDescription>
            Bulk-delete sessions by age. Running sessions and OpenCode sessions
            are always skipped; Codex sessions are archived instead of deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1">
          {PRESETS.map((preset, idx) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => setPresetIdx(idx)}
              className={cn(
                "cursor-pointer rounded-md px-2 py-1 text-left text-[12px] transition-colors",
                idx === presetIdx
                  ? "bg-foreground/[0.08] text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04]",
              )}
            >
              {preset.label}
            </button>
          ))}
          {PRESETS[presetIdx].days === null ? (
            <Input
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              placeholder="YYYY-MM-DD"
              className="mt-1 h-7 text-[12px]"
            />
          ) : null}
        </div>
        <p className="text-[12px] text-muted-foreground">
          {threshold === null
            ? "Enter a valid date."
            : `${targets.length} session(s) will be removed` +
              (skippedActive ? ` · ${skippedActive} active skipped` : "")}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={targets.length === 0}
            onClick={() => {
              onConfirm(targets);
              onClose();
            }}
          >
            Delete {targets.length || ""}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
