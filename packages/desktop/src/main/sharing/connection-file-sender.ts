// ConnectionFileSender - the FileSender the AmbientShareService drives, backed by
// the desktop's EXISTING transfer (ConnectionManager.sendFile), which already
// streams and HTTP-accelerates large files. This is the adapter, not a new
// transport: ambient sharing decides WHAT/WHO/WHEN; the proven connection layer
// moves the bytes.
//
// ConnectionManager exposes a single connection-state callback, so this does NOT
// register its own (that would clobber the app's renderer-forwarding handler).
// Instead the app forwards state in via updateConnection(); we track the current
// device and fire onReconnect so the offline queue drains.

import type { ConnectionState } from '@easyshare/shared';
import type { FileSender } from '@easyshare/shared';

/** The slice of ConnectionManager this adapter needs. */
export interface FileTransferConnection {
  sendFile(filePath: string): Promise<boolean>;
}

export class ConnectionFileSender implements FileSender {
  private readonly conn: FileTransferConnection;
  private connectedId: string | null = null;
  private readonly reconnectHandlers = new Set<(deviceId: string) => void>();

  constructor(conn: FileTransferConnection) {
    this.conn = conn;
  }

  /**
   * Called by the app from its connection-state handler. Tracks the connected
   * device and, on a fresh connection, fires reconnect so queued shares drain.
   */
  updateConnection(state: ConnectionState): void {
    const id = state.status === 'connected' ? state.device?.id ?? null : null;
    const previous = this.connectedId;
    this.connectedId = id;
    if (id && id !== previous) {
      for (const handler of this.reconnectHandlers) handler(id);
    }
  }

  // --- FileSender ----------------------------------------------------------

  connectedDeviceIds(): string[] {
    return this.connectedId ? [this.connectedId] : [];
  }

  async sendFile(
    deviceId: string,
    path: string,
    _fileName: string,
    _mimeType: string
  ): Promise<boolean> {
    // The existing transport sends to the one connected device; guard that the
    // target is actually that device before handing off.
    if (deviceId !== this.connectedId) return false;
    return this.conn.sendFile(path);
  }

  onReconnect(handler: (deviceId: string) => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }
}
