import { useCallback, useEffect, useRef } from "react";
import {
  listenFsChanged,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import { loadFolders } from "../lib/folders";
import { loadAllMetadata } from "../lib/metadata";
import {
  listLiveSessions,
  listProviders,
  listQuotas,
  listSessions,
} from "../lib/native";
import { useAgentSessionsStore } from "../store/agentSessionsStore";

const REFRESH_DEBOUNCE_MS = 400;

/**
 * Loads providers + sessions into the store and keeps them fresh without
 * burning CPU: the live registry (~/.claude/sessions) churns on every state
 * transition of a running session, so its events only re-stamp the ACTIVE
 * badges via the cheap agent_live_sessions command; only events under the
 * providers' data roots trigger a real rescan (which the backend's per-file
 * mtime caches keep cheap anyway). Window focus refetches through the 3s TTL.
 */
export function useAgentSessions(home: string | null) {
  const {
    setProviders,
    setSessions,
    setLoading,
    setError,
    applyLiveSessions,
    setAllMetadata,
    setFolders,
    setQuotas,
  } = useAgentSessionsStore.getState();
  const scanDebounceRef = useRef<number | null>(null);
  const liveDebounceRef = useRef<number | null>(null);

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
        // Quota badges are best-effort; never fail the refresh over them.
        void listQuotas()
          .then(setQuotas)
          .catch(() => {});
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [setProviders, setSessions, setLoading, setError, setQuotas],
  );

  const refreshLiveBadges = useCallback(async () => {
    try {
      const live = await listLiveSessions();
      applyLiveSessions(new Set(live.map((l) => l.sessionId)));
    } catch {
      // badge staleness is acceptable; the next full refresh corrects it
    }
  }, [applyLiveSessions]);

  useEffect(() => {
    void refresh();
    void loadAllMetadata()
      .then(setAllMetadata)
      .catch(() => {});
    void loadFolders()
      .then(setFolders)
      .catch(() => {});
  }, [refresh, setAllMetadata, setFolders]);

  useEffect(() => {
    if (!home) return;
    const liveRegistryDir = `${home}/.claude/sessions`;
    const dataDirs = [
      `${home}/.claude/projects`,
      `${home}/.codex/sessions`,
      `${home}/.gemini/tmp`,
    ];
    watchAdd([liveRegistryDir, ...dataDirs]);
    let dispose: (() => void) | undefined;
    void listenFsChanged((paths) => {
      const touchesLiveRegistry = paths.some((p) =>
        p.includes(liveRegistryDir),
      );
      const touchesData = paths.some((p) =>
        dataDirs.some((d) => p.includes(d)),
      );
      if (touchesLiveRegistry && !touchesData) {
        if (liveDebounceRef.current !== null)
          window.clearTimeout(liveDebounceRef.current);
        liveDebounceRef.current = window.setTimeout(() => {
          liveDebounceRef.current = null;
          void refreshLiveBadges();
        }, REFRESH_DEBOUNCE_MS);
        return;
      }
      if (!touchesData) return;
      if (scanDebounceRef.current !== null)
        window.clearTimeout(scanDebounceRef.current);
      scanDebounceRef.current = window.setTimeout(() => {
        scanDebounceRef.current = null;
        void refresh(true);
      }, REFRESH_DEBOUNCE_MS);
    }).then((d) => {
      dispose = d;
    });
    return () => {
      watchRemove([liveRegistryDir, ...dataDirs]);
      dispose?.();
      if (scanDebounceRef.current !== null)
        window.clearTimeout(scanDebounceRef.current);
      if (liveDebounceRef.current !== null)
        window.clearTimeout(liveDebounceRef.current);
    };
  }, [home, refresh, refreshLiveBadges]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { refresh };
}
