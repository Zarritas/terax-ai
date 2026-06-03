import { Streamdown } from "streamdown";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { SessionMetadata } from "../lib/metadata";
import type { AgentSession, PreviewTurn } from "../lib/native";
import { sessionLabel } from "../lib/parse";

export type PreviewState = {
  session: AgentSession;
  /** null while loading. */
  turns: PreviewTurn[] | null;
  error: string | null;
} | null;

type Props = {
  preview: PreviewState;
  metadata: Record<string, SessionMetadata>;
  onClose: () => void;
};

export function SessionPreviewDialog({ preview, metadata, onClose }: Props) {
  if (!preview) return null;
  const { session, turns, error } = preview;
  const meta = metadata[`${session.provider}:${session.id}`];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">
            {sessionLabel(session, meta)}
          </DialogTitle>
        </DialogHeader>
        <p className="break-all font-mono text-[10px] text-muted-foreground">
          {session.provider} · {session.id}
        </p>
        <div className="max-h-[55vh] overflow-y-auto">
          {turns === null && !error ? (
            <div className="flex items-center justify-center py-8">
              <Spinner />
            </div>
          ) : null}
          {error ? (
            <p className="py-4 text-[12px] text-muted-foreground">
              {error === "unsupported"
                ? "Preview is not available for OpenCode sessions (their content lives in OpenCode's own database)."
                : error}
            </p>
          ) : null}
          {turns !== null && turns.length === 0 && !error ? (
            <p className="py-4 text-[12px] text-muted-foreground">
              No readable turns in this session.
            </p>
          ) : null}
          <div className="flex flex-col gap-3 pr-3">
            {(turns ?? []).map((turn, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: static list replaced wholesale on open; turns have no id
                key={`${turn.role}-${i}`}
                className={cn(
                  "rounded-md border px-2.5 py-1.5",
                  turn.role === "user"
                    ? "border-border/60 bg-foreground/[0.03]"
                    : "border-primary/20 bg-primary/[0.04]",
                )}
              >
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {turn.role === "user" ? "User" : "Assistant"}
                </p>
                <Streamdown className="prose-sm text-[12px] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                  {turn.text}
                </Streamdown>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
