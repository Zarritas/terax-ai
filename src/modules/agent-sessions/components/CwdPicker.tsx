import { cn } from "@/lib/utils";

export function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

export function CwdPicker({
  cwds,
  selected,
  onSelect,
  emptyText = "No projects found.",
}: {
  cwds: string[];
  selected: string | null;
  onSelect: (cwd: string) => void;
  emptyText?: string;
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
            {emptyText}
          </p>
        ) : null}
      </div>
    </div>
  );
}
