// Behavior-faithful fake transport for the shared ambient-sharing tests. The
// FileSender is the boundary between this package's policy layer and the app's
// device-to-device transfer (which lives in the app, not here). Faking it here
// is faking at that boundary: the real code above it (AmbientShareService,
// policy, queue) runs for real, and the observable outcome is which files the
// transport was asked to (and did) deliver. The REAL byte-landing over a real
// socket is proven in the desktop integration test that drives ConnectionManager.

import type { FileSender } from '@easyshare/shared';

export interface Delivered {
  deviceId: string;
  path: string;
  fileName: string;
}

export class FakeTransport implements FileSender {
  /** Files actually delivered (accepted by a connected, non-failing peer). */
  readonly delivered: Delivered[] = [];
  /** Simulate delivery failure even while connected (peer rejects). */
  fail = false;

  private readonly connected = new Set<string>();
  private readonly reconnectHandlers = new Set<(deviceId: string) => void>();

  constructor(initiallyConnected: string[] = []) {
    for (const id of initiallyConnected) this.connected.add(id);
  }

  connectedDeviceIds(): string[] {
    return [...this.connected];
  }

  async sendFile(
    deviceId: string,
    path: string,
    fileName: string,
    _mimeType: string
  ): Promise<boolean> {
    if (!this.connected.has(deviceId) || this.fail) return false;
    this.delivered.push({ deviceId, path, fileName });
    return true;
  }

  onReconnect(handler: (deviceId: string) => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }

  // --- test controls -------------------------------------------------------

  /** Bring a device online and fire reconnect (drives queue drain). */
  bringOnline(deviceId: string): void {
    this.connected.add(deviceId);
    for (const handler of this.reconnectHandlers) handler(deviceId);
  }

  takeOffline(deviceId: string): void {
    this.connected.delete(deviceId);
  }

  /** Count of deliveries to a device (or all). */
  count(deviceId?: string): number {
    return deviceId ? this.delivered.filter((d) => d.deviceId === deviceId).length : this.delivered.length;
  }
}

/** Await until predicate() is true or `tries` macrotask turns elapse. */
export async function waitFor(predicate: () => boolean, tries = 50): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return predicate();
}
