// Pending-share queue. When decideShares() returns 'queue' for an offline
// destination, the orchestrator parks the (event, destination) pair here and
// drains it when that destination reconnects. Pure logic, zero I/O: the host
// app owns persistence (write this out to disk) and the actual send.

import type { CaptureEvent } from './types';

/** One deferred send: a captured item waiting for a specific destination. */
export interface PendingShare {
  event: CaptureEvent;
  destinationId: string;
  queuedAt: number;
}

/** Stable key for a pending item so the same (event, dest) isn't queued twice. */
function keyOf(eventId: string, destinationId: string): string {
  return `${destinationId}:${eventId}`;
}

/**
 * Add a pending share unless the same (event, destination) is already queued.
 * Returns a new array (never mutates the input).
 */
export function enqueue(
  queue: PendingShare[],
  event: CaptureEvent,
  destinationId: string,
  queuedAt: number
): PendingShare[] {
  const exists = queue.some(
    (p) => keyOf(p.event.id, p.destinationId) === keyOf(event.id, destinationId)
  );
  return exists ? queue : [...queue, { event, destinationId, queuedAt }];
}

/** All pending shares for a destination, oldest first (send order). */
export function pendingFor(queue: PendingShare[], destinationId: string): PendingShare[] {
  return queue
    .filter((p) => p.destinationId === destinationId)
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

/**
 * Remove every pending share for a destination - call after they've been
 * drained/sent on reconnect. Returns a new array.
 */
export function clearDestination(
  queue: PendingShare[],
  destinationId: string
): PendingShare[] {
  return queue.filter((p) => p.destinationId !== destinationId);
}

/** Remove a single (event, destination) pending share (e.g. after one send). */
export function remove(
  queue: PendingShare[],
  eventId: string,
  destinationId: string
): PendingShare[] {
  const target = keyOf(eventId, destinationId);
  return queue.filter((p) => keyOf(p.event.id, p.destinationId) !== target);
}

/**
 * Drop pending shares older than maxAgeMs (a queued screenshot from last week is
 * probably noise). Returns a new array.
 */
export function prune(queue: PendingShare[], now: number, maxAgeMs: number): PendingShare[] {
  return queue.filter((p) => now - p.queuedAt < maxAgeMs);
}
