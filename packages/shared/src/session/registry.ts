// SessionRegistry - the mesh piece, platform-agnostic. Both apps track a single
// connected device today; ambient sharing must reach every paired device, so this
// holds one TransferSession per connected device (keyed by device id) and is the
// FileSender the AmbientShareService drives. It depends only on ByteChannel +
// FileStore, so desktop (net.Socket) and mobile (react-native-tcp-socket) share
// this one implementation and supply only their own channel/fs adapters.

import type { ByteChannel, FileStore } from './ports';
import { TransferSession, type ReceivedFile } from './index';
import type { FileSender } from '../sharing/service';

type ReconnectHandler = (deviceId: string) => void;

export interface SessionRegistryOptions {
  fileStore: FileStore;
  /** Notified when any device finishes receiving a file (for toast/history). */
  onFileReceived?: (deviceId: string, file: ReceivedFile) => void;
}

export class SessionRegistry implements FileSender {
  private readonly fileStore: FileStore;
  private readonly onFileReceived?: (deviceId: string, file: ReceivedFile) => void;
  private readonly sessions = new Map<string, TransferSession>();
  private readonly reconnectHandlers = new Set<ReconnectHandler>();

  constructor(options: SessionRegistryOptions) {
    this.fileStore = options.fileStore;
    this.onFileReceived = options.onFileReceived;
  }

  /**
   * Register (or replace) the live session for a device - called when a paired
   * device connects, with its channel and the pairing's shared secret. Firing the
   * reconnect handlers lets the AmbientShareService drain anything queued for it.
   */
  connect(deviceId: string, channel: ByteChannel, secretKey: string): void {
    const session = new TransferSession({
      channel,
      fileStore: this.fileStore,
      secretKey,
      onFileReceived: (file) => this.onFileReceived?.(deviceId, file),
    });
    this.sessions.set(deviceId, session);
    for (const handler of this.reconnectHandlers) handler(deviceId);
  }

  /** Drop a device's session when it disconnects. */
  disconnect(deviceId: string): void {
    this.sessions.delete(deviceId);
  }

  // --- FileSender ----------------------------------------------------------

  connectedDeviceIds(): string[] {
    return [...this.sessions.keys()];
  }

  async sendFile(
    deviceId: string,
    filePath: string,
    fileName: string,
    mimeType: string
  ): Promise<boolean> {
    const session = this.sessions.get(deviceId);
    if (!session) return false;
    const result = await session.sendFile(filePath, fileName, mimeType);
    return result.success;
  }

  onReconnect(handler: ReconnectHandler): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }
}
