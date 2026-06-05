import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Tab } from "@/modules/tabs";
import { leafHasForegroundProcess, leafIds } from "@/modules/terminal";

/**
 * Window-level close guard, mirroring useTabCloseGuards: closing the window
 * with a dirty editor or a terminal running a foreground process routes
 * through a confirmation dialog instead of killing everything silently.
 *
 * Tauri keeps the window open while onCloseRequested handlers run, so the
 * async foreground-process probe can finish before deciding; confirming
 * destroys the window directly, bypassing this guard.
 */
export function useWindowCloseGuard(tabs: Tab[]) {
  const [pendingWindowClose, setPendingWindowClose] = useState(false);
  // The close event fires outside React's render cycle; a ref keeps the
  // listener stable while always seeing the latest tabs.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      const current = tabsRef.current;
      let busy = current.some((t) => t.kind === "editor" && t.dirty);
      if (!busy) {
        const leaves = current.flatMap((t) =>
          t.kind === "terminal" ? leafIds(t.paneTree) : [],
        );
        const checks = await Promise.all(leaves.map(leafHasForegroundProcess));
        busy = checks.some(Boolean);
      }
      if (busy) {
        event.preventDefault();
        setPendingWindowClose(true);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const confirmWindowClose = useCallback(() => {
    setPendingWindowClose(false);
    void getCurrentWindow().destroy();
  }, []);

  const cancelWindowClose = useCallback(() => {
    setPendingWindowClose(false);
  }, []);

  return { pendingWindowClose, confirmWindowClose, cancelWindowClose };
}
