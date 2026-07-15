// The CaptureWatcher port. Each platform implements this natively (macOS
// NSMetadataQuery on kMDItemIsScreenCapture for screenshots + FSEvents for
// files; Android MediaStore ContentObserver; etc.) and emits normalized
// CaptureEvents. This module defines the contract plus the pure debounce/dedup
// discipline every implementation must apply, so the same anti-loop and
// anti-storm rules live in one tested place rather than in each native adapter.

import type { CaptureEvent, CaptureSource } from './types';

/** Called for every accepted capture. */
export type CaptureListener = (event: CaptureEvent) => void;

/**
 * A platform-native source of capture events. Implementations own the OS
 * observers and file I/O; they must feed raw events through `shouldEmit` (below)
 * before calling the listener, to enforce dedup + debounce uniformly.
 */
export interface CaptureWatcher {
  /** Begin observing the given sources. Idempotent. */
  start(sources: CaptureSource[]): Promise<void>;
  /** Stop observing and release native resources. */
  stop(): Promise<void>;
  /** Register the sink for accepted events. Returns an unsubscribe fn. */
  onCapture(listener: CaptureListener): () => void;
}

/** Tunables for the shared dedup/debounce gate. */
export interface EmitGuardOptions {
  /**
   * Ignore a capture whose id was already seen within this window (ms).
   * Guards against the OS emitting write -> rename -> xattr as several events
   * for one screenshot. Default 10s, matching Syncthing's coalesce window.
   */
  dedupWindowMs?: number;
  /**
   * Absolute paths (or path prefixes) the watcher must never emit for - most
   * importantly the inbound/received directory, so an incoming file can't be
   * observed and bounced straight back (the classic sync loop).
   */
  ignoredPathPrefixes?: string[];
}

/**
 * Mutable, in-memory state for the emit guard. Kept explicit (not hidden in a
 * closure) so callers can persist/inspect it and tests can drive it directly.
 */
export interface EmitGuardState {
  /** event id -> last-seen timestamp (ms). */
  seen: Map<string, number>;
}

/** Fresh guard state. */
export function createEmitGuardState(): EmitGuardState {
  return { seen: new Map() };
}

/**
 * Pure gate deciding whether a raw capture should be emitted to listeners.
 * Rejects events under an ignored prefix and events seen within the dedup
 * window; otherwise records the event and accepts it. Mutates `state.seen`
 * (the point of the guard) but performs no I/O.
 */
export function shouldEmit(
  event: CaptureEvent,
  state: EmitGuardState,
  options: EmitGuardOptions = {}
): boolean {
  const { dedupWindowMs = 10_000, ignoredPathPrefixes = [] } = options;

  if (ignoredPathPrefixes.some((prefix) => event.path.startsWith(prefix))) {
    return false;
  }

  const last = state.seen.get(event.id);
  if (last !== undefined && event.capturedAt - last < dedupWindowMs) {
    return false;
  }

  state.seen.set(event.id, event.capturedAt);
  return true;
}

/**
 * Drop dedup entries older than the window, so `seen` doesn't grow unbounded on
 * a long-running watcher. Call periodically (e.g. on each emit or a timer).
 */
export function pruneEmitGuard(
  state: EmitGuardState,
  now: number,
  dedupWindowMs = 10_000
): void {
  for (const [id, ts] of state.seen) {
    if (now - ts >= dedupWindowMs) state.seen.delete(id);
  }
}
