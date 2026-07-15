// Ambient sharing types - the "capture -> policy -> send" layer that sits on top
// of the existing transport. Pure types plus a decision contract; zero I/O.
// Platforms implement the CaptureWatcher (native screenshot/photo/file/download
// observers) and perform the actual transfer; this module only decides WHAT
// should happen to a captured item and for WHICH destination.

/** A kind of thing the OS can produce that the user may choose to auto-share. */
export type CaptureSource =
  | 'screenshot'
  | 'photo'
  | 'screen_recording'
  | 'download'
  | 'file'; // arbitrary file via the share sheet / manual pick

/**
 * How aggressively a source is shared to a destination.
 *   off  - never share this source to this destination
 *   ask  - notify and let the user confirm each item (only when reachable)
 *   auto - share silently, no confirmation
 */
export type ShareMode = 'off' | 'ask' | 'auto';

/** What to do when a chosen destination is not currently reachable. */
export type OfflineBehavior = 'skip' | 'queue';

/** A single captured item the platform observed. */
export interface CaptureEvent {
  /** Stable id for dedupe (e.g. a hash of the path, or the OS asset id). */
  id: string;
  source: CaptureSource;
  /** Absolute local path to the captured file. */
  path: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  /** When the capture happened (ms since epoch). */
  capturedAt: number;
}

/**
 * A per-(source, destination) rule. `destinationId` may be a specific paired
 * device id, or '*' for the default applied to every device unless a
 * device-specific rule overrides it.
 */
export interface ShareRule {
  source: CaptureSource;
  /** A PairedDevice id, or '*' for all devices. */
  destinationId: string;
  mode: ShareMode;
}

/** The complete, user-controlled sharing configuration. */
export interface SharePolicy {
  /** Source x destination rules. A device-specific rule wins over a '*' rule. */
  rules: ShareRule[];
  /** What to do when a chosen destination is offline. */
  offlineBehavior: OfflineBehavior;
}

/** One candidate destination and whether it is reachable right now. */
export interface DestinationState {
  deviceId: string;
  connected: boolean;
}

/**
 * The action the orchestrator should take for one (event, destination) pair.
 *   send   - deliver now over the active transport
 *   prompt - ask the user to confirm, then send on confirm
 *   queue  - defer; re-decide when the destination reconnects
 *   skip   - do nothing
 */
export type ShareAction = 'send' | 'prompt' | 'queue' | 'skip';

/** The resolved decision for a single (event, destination) pair. */
export interface ShareDecision {
  destinationId: string;
  action: ShareAction;
  /** Human-readable justification, for local logging (never leaves the device). */
  reason: string;
}
