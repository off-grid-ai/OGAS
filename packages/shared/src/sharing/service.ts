// AmbientShareService - the owning service for the "capture -> policy -> send"
// flow. It holds the pending-share queue and coordinates the pure decision
// engine (policy.ts) with an injected FileSender (satisfied in the app by a
// registry of TransferSessions, one per paired device). No I/O of its own: it
// decides, then delegates sending to the port.

import type { CaptureEvent, DestinationState, ShareDecision, SharePolicy } from './types';
import { decideShares } from './policy';
import { enqueue, pendingFor, remove, type PendingShare } from './queue';

/**
 * Sends a captured file to a specific paired device and reports connectivity.
 * The app implements this over its TransferSessions; a send resolves true only
 * when the receiver has written and verified the file.
 */
export interface FileSender {
  /** Device ids with a live connection right now. */
  connectedDeviceIds(): string[];
  /** Deliver a file to one device. Resolves true iff the peer confirmed receipt. */
  sendFile(
    deviceId: string,
    path: string,
    fileName: string,
    mimeType: string
  ): Promise<boolean>;
  /** Fires when a device (re)connects, so the queue for it can be drained. */
  onReconnect(handler: (deviceId: string) => void): () => void;
}

/** Surfaced when a capture needs user confirmation before sending ('ask' mode). */
export interface SharePrompt {
  event: CaptureEvent;
  destinationId: string;
  /** Call to proceed with the send; resolves true iff the peer confirmed receipt. */
  confirm: () => Promise<boolean>;
}

export interface AmbientShareServiceOptions {
  getPolicy: () => SharePolicy;
  /** All destinations to consider (paired devices) with current reachability. */
  getDestinations: () => DestinationState[];
  sender: FileSender;
  /** Invoked for each 'ask'-mode decision on a reachable destination. */
  onPrompt?: (prompt: SharePrompt) => void;
  /** Clock injection for deterministic queue timestamps. Defaults to Date.now. */
  now?: () => number;
}

export class AmbientShareService {
  private readonly getPolicy: () => SharePolicy;
  private readonly getDestinations: () => DestinationState[];
  private readonly sender: FileSender;
  private readonly onPrompt?: (prompt: SharePrompt) => void;
  private readonly now: () => number;
  private readonly unsubscribeReconnect: () => void;

  private queue: PendingShare[] = [];

  constructor(options: AmbientShareServiceOptions) {
    this.getPolicy = options.getPolicy;
    this.getDestinations = options.getDestinations;
    this.sender = options.sender;
    this.onPrompt = options.onPrompt;
    this.now = options.now ?? Date.now;
    this.unsubscribeReconnect = this.sender.onReconnect((deviceId) => {
      void this.drain(deviceId);
    });
  }

  /** Read-only view of what is currently queued (for UI / persistence). */
  get pending(): readonly PendingShare[] {
    return this.queue;
  }

  /** Stop listening for reconnects. Call on teardown. */
  dispose(): void {
    this.unsubscribeReconnect();
  }

  /**
   * Run one captured item through the policy and act on every destination:
   * send now, prompt the user, queue for later, or skip. Returns the decisions
   * so callers can log/observe; the observable effect is the file arriving.
   */
  async handleCapture(event: CaptureEvent): Promise<ShareDecision[]> {
    const decisions = decideShares(event, this.getPolicy(), this.getDestinations());
    await Promise.all(decisions.map((decision) => this.act(event, decision)));
    return decisions;
  }

  private async act(event: CaptureEvent, decision: ShareDecision): Promise<void> {
    switch (decision.action) {
      case 'send':
        await this.send(event, decision.destinationId);
        return;
      case 'queue':
        this.queue = enqueue(this.queue, event, decision.destinationId, this.now());
        return;
      case 'prompt':
        this.onPrompt?.({
          event,
          destinationId: decision.destinationId,
          confirm: () => this.send(event, decision.destinationId),
        });
        return;
      case 'skip':
        return;
    }
  }

  private send(event: CaptureEvent, destinationId: string): Promise<boolean> {
    return this.sender.sendFile(destinationId, event.path, event.fileName, event.mimeType);
  }

  /** Send everything queued for a device, clearing each item that lands. */
  private async drain(deviceId: string): Promise<void> {
    for (const item of pendingFor(this.queue, deviceId)) {
      const ok = await this.send(item.event, deviceId);
      if (ok) this.queue = remove(this.queue, item.event.id, deviceId);
    }
  }
}
