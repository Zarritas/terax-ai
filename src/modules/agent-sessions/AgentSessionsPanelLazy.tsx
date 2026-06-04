import type { ComponentProps } from "react";
import { lazy, Suspense } from "react";
import type { AgentSessionsPanel as AgentSessionsPanelType } from "./components/AgentSessionsPanel";

const AgentSessionsPanelInner = lazy(() =>
  import("./components/AgentSessionsPanel").then((m) => ({
    default: m.AgentSessionsPanel,
  })),
);

type Props = ComponentProps<typeof AgentSessionsPanelType>;

export function AgentSessionsPanel(props: Props) {
  return (
    <Suspense fallback={null}>
      <AgentSessionsPanelInner {...props} />
    </Suspense>
  );
}
