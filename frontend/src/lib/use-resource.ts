"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Resource<T> = {
  data: T | null;
  error: unknown;
  /** True only while nothing has loaded yet. A background refresh keeps showing real data. */
  loading: boolean;
  reload: () => void;
};

type State<T> = { data: T | null; error: unknown; settled: boolean };

/**
 * Loads a value from the API and keeps loading/error/data honest.
 *
 * On failure `data` is cleared and `error` is set, so a view built on this can never silently
 * render an empty list when the request actually failed. `intervalMs` re-polls while `shouldPoll`
 * returns true, which is how in-progress runs update without a websocket.
 */
export function useResource<T>(load: () => Promise<T>, deps: unknown[], options: { intervalMs?: number; shouldPoll?: (value: T) => boolean } = {}): Resource<T> {
  const [state, setState] = useState<State<T>>({ data: null, error: null, settled: false });
  const [nonce, setNonce] = useState(0);

  // Latest-value refs, synced in an effect so the polling effect below does not restart every
  // time a caller passes a fresh inline closure.
  const loadRef = useRef(load);
  const shouldPollRef = useRef(options.shouldPoll);
  useEffect(() => {
    loadRef.current = load;
    shouldPollRef.current = options.shouldPoll;
  });

  const reload = useCallback(() => setNonce(value => value + 1), []);
  const intervalMs = options.intervalMs;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // State is only ever written after an await, so this never triggers a cascading render.
    const run = async () => {
      try {
        const value = await loadRef.current();
        if (cancelled) return;
        setState({ data: value, error: null, settled: true });
        if (intervalMs && shouldPollRef.current?.(value)) timer = setTimeout(run, intervalMs);
      } catch (caught) {
        if (cancelled) return;
        // Stop polling on error rather than hammering a failing endpoint.
        setState({ data: null, error: caught, settled: true });
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, intervalMs, ...deps]);

  return { data: state.data, error: state.error, loading: !state.settled, reload };
}
