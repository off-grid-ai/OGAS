// The two device-boundary ports a TransferSession depends on. The app supplies
// the real implementations (a TCP socket, the native filesystem); tests supply
// in-memory fakes. Everything ABOVE these ports - framing, encryption,
// chunking, reassembly, integrity - is real shared logic and runs unchanged in
// both, which is what makes the session integration-testable in-process.

/**
 * A bidirectional byte pipe to one remote device. This is the socket boundary:
 * `send` puts bytes on the wire; `onData` receives whatever the peer sent. The
 * session frames/deframes on top, so a raw TCP socket satisfies this directly.
 */
export interface ByteChannel {
  /** Put a frame on the wire. May be called many times per transfer. */
  send(frame: Uint8Array): void;
  /** Register the single sink for inbound bytes. Later calls replace it. */
  onData(handler: (data: Uint8Array) => void): void;
}

/**
 * File read/write boundary. The app backs this with real disk I/O (RNFS,
 * node:fs); tests back it with an in-memory map. `inboundPath` decides where a
 * received file lands, and is the one directory the capture watcher must ignore
 * so an incoming file can't be observed and bounced back (anti-loop).
 */
export interface FileStore {
  /** Read a file's full contents. Rejects if absent. */
  read(path: string): Promise<Uint8Array>;
  /** Write a received file's full contents, creating parents as needed. */
  write(path: string, data: Uint8Array): Promise<void>;
  /** The absolute path a received file with this name should be written to. */
  inboundPath(fileName: string): string;
}
