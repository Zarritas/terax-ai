import { useCallback, useEffect, useRef } from "react";
import {
  listenFsChanged,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import { listProviders, listSessions } from "../lib/native";
import { useAgentSessionsStore } from "../store/agentSessionsStore";

const REFRESH_DEBOUNCE_MS = 400;

/** Provider data dirs relative to home; used to scope fs:changed refetches. */
const DATA_SUBDIRS = [".claude", ".codex", ".gemini"];

/**
 * Loads providers + sessions into the store and keeps them fresh: watches the
 * providers' registry dirs (non-recursive — enough for Claude's live registry
 * and new project dirs), refetches on window focus, and exposes a manual
 * refresh. The backend's TTL cache makes overlapping refetches cheap.
 */
export function useAgentSessions(home: string | null) {
  const { setProviders, setSessions, setLoading, setError } =
    useAgentSessionsStore.getState();
  const debounceRef = useRef<number | null>(null);

  const refresh = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const [providers, sessions] = await Promise.all([
          listProviders(),
          listSessions(force),
        ]);
        setProviders(providers);
        setSessions(sessions);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [setProviders, setSessions, setLoading, setError],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Watch the live registry (~/.claude/sessions) and provider roots so the
  // ACTIVE badge tracks reality without polling. Non-recursive: deep jsonl
  // appends rely on the focus refetch below.
  useEffect(() => {
    if (!home) return;
    const dirs = [
      `${home}/.claude/sessions`,
      `${home}/.claude/projects`,
      `${home}/.codex/sessions`,
      `${home}/.gemini/tmp`,
    ];
    watchAdd(dirs);
    let dispose: (() => void) | undefined;
    void listenFsChanged((paths) => {
      const relevant = paths.some((p) =>
        DATA_SUBDIRS.some((sub) => p.includes(`${home}/${sub}`)),
      );
      if (!relevant) return;
      if (debounceRef.current !== null)
        window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        void refresh(true);
      }, REFRESH_DEBOUNCE_MS);
    }).then((d) => {
      dispose = d;
    });
    return () => {
      watchRemove(dirs);
      dispose?.();
      if (debounceRef.current !== null)
        window.clearTimeout(debounceRef.current);
    };
  }, [home, refresh]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { refresh };
}
