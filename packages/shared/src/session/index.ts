// TransferSession - the file-transfer state machine for ONE paired device,
// lifted out of the app's socket/fs code so it can run in-process. It owns the
// request -> accept -> chunk -> complete -> ack handshake on the send side and
// the receive -> reassemble -> verify -> write side, over injected ports
// (ByteChannel + FileStore). Every message rides an encrypted SecureChannel, so
// file contents are NaCl-encrypted end to end on the wire.
//
// Pure transfer logic (chunking, checksums, reassembly) comes from ../transfer;
// wire encryption/framing from ./secure-channel. This module only sequences them
// and holds the per-transfer state.

import type { Message, FileRequestMessage } from '../types';
import {
  createFileRequest,
  createFileAccept,
  createFileReject,
  createFileChunk,
  createFileComplete,
  createFileAck,
  chunkFile,
  reassembleChunks,
  verifyFileIntegrity,
  CHUNK_SIZE,
} from '../transfer';
import { decodeBase64 } from '../crypto';
import type { ByteChannel, FileStore } from './ports';
import { SecureChannel } from './secure-channel';

export type { ByteChannel, FileStore } from './ports';
export { SecureChannel, FrameReader, frameMessage } from './secure-channel';
export { SessionRegistry } from './registry';
export type { SessionRegistryOptions } from './registry';

/** Result of a completed (or failed) outbound file transfer. */
export interface SendResult {
  success: boolean;
  /** Present on failure: why it did not complete. */
  reason?: string;
}

/** A file that finished arriving and was written to the FileStore. */
export interface ReceivedFile {
  fileName: string;
  fileSize: number;
  mimeType: string;
  /** Where it was written (FileStore.inboundPath). */
  path: string;
}

export interface TransferSessionOptions {
  channel: ByteChannel;
  fileStore: FileStore;
  /** Base64 NaCl key shared with the peer (from deriveSharedSecret). */
  secretKey: string;
  /**
   * Decide whether to accept an inbound file. Defaults to accept-all, which is
   * correct for an already-paired device on the ambient path; a cross-license
   * or manual flow can gate here.
   */
  acceptFile?: (request: FileRequestMessage) => boolean;
  /** Called after a file is fully received, verified, and written. */
  onFileReceived?: (file: ReceivedFile) => void;
  /** Chunk size override (bytes). Defaults to the shared CHUNK_SIZE (64 KB). */
  chunkSize?: number;
}

interface OutboundTransfer {
  data: Uint8Array;
  fileName: string;
  mimeType: string;
  resolve: (result: SendResult) => void;
}

interface InboundTransfer {
  fileName: string;
  fileSize: number;
  mimeType: string;
  checksum: string;
  totalChunks: number;
  chunks: Map<number, Uint8Array>;
}

export class TransferSession {
  private readonly fileStore: FileStore;
  private readonly acceptFile: (request: FileRequestMessage) => boolean;
  private readonly onFileReceived?: (file: ReceivedFile) => void;
  private readonly chunkSize: number;

  /** The encrypted message pipe this session sends/receives over. */
  private readonly secure: SecureChannel;
  /** Outbound transfers awaiting their file_ack, keyed by request id. */
  private readonly outbound = new Map<string, OutboundTransfer>();
  /** Inbound transfers being assembled, keyed by request id. */
  private readonly inbound = new Map<string, InboundTransfer>();

  constructor(options: TransferSessionOptions) {
    this.fileStore = options.fileStore;
    this.acceptFile = options.acceptFile ?? (() => true);
    this.onFileReceived = options.onFileReceived;
    this.chunkSize = options.chunkSize ?? CHUNK_SIZE;

    this.secure = new SecureChannel(options.channel, options.secretKey, (message) =>
      this.handle(message)
    );
  }

  /**
   * Send a file to the peer. Resolves when the peer acks completion (success)
   * or the transfer is rejected/fails (success:false). The returned promise
   * settling means the receiver has written and verified the file, or not.
   */
  async sendFile(path: string, fileName: string, mimeType: string): Promise<SendResult> {
    const data = await this.fileStore.read(path);
    const request = createFileRequest(fileName, data.length, mimeType, data);
    return new Promise<SendResult>((resolve) => {
      this.outbound.set(request.id, { data, fileName, mimeType, resolve });
      this.secure.send(request);
    });
  }

  // --- message handling -----------------------------------------------------

  private handle(message: Message): void {
    switch (message.type) {
      case 'file_request':
        return this.onFileRequest(message as FileRequestMessage);
      case 'file_accept':
        return this.onFileAccept(message);
      case 'file_reject':
        return this.onFileReject(message);
      case 'file_chunk':
        return this.onFileChunk(message);
      case 'file_complete':
        void this.onFileComplete(message);
        return;
      case 'file_ack':
        return this.onFileAck(message);
      default:
        return; // ping/pong/pairing handled elsewhere
    }
  }

  private onFileRequest(request: FileRequestMessage): void {
    if (!this.acceptFile(request)) {
      this.secure.send(createFileReject(request.id, 'declined by policy'));
      return;
    }
    const { fileName, fileSize, mimeType, checksum } = request.payload;
    this.inbound.set(request.id, {
      fileName,
      fileSize,
      mimeType,
      checksum,
      totalChunks: 0,
      chunks: new Map(),
    });
    this.secure.send(createFileAccept(request.id));
  }

  private onFileAccept(message: Message): void {
    const requestId = (message.payload as { requestId: string }).requestId;
    const transfer = this.outbound.get(requestId);
    if (!transfer) return;
    for (const { chunk, index, total } of chunkFile(transfer.data, this.chunkSize)) {
      this.secure.send(createFileChunk(requestId, index, total, chunk));
    }
    this.secure.send(createFileComplete(requestId, transfer.data));
  }

  private onFileReject(message: Message): void {
    const { requestId, reason } = message.payload as { requestId: string; reason: string };
    this.settleOutbound(requestId, { success: false, reason });
  }

  private onFileChunk(message: Message): void {
    const { requestId, chunkIndex, totalChunks, data } = message.payload as {
      requestId: string;
      chunkIndex: number;
      totalChunks: number;
      data: string;
    };
    const transfer = this.inbound.get(requestId);
    if (!transfer) return;
    transfer.totalChunks = totalChunks;
    transfer.chunks.set(chunkIndex, decodeBase64(data));
  }

  private async onFileComplete(message: Message): Promise<void> {
    const { requestId, checksum } = message.payload as { requestId: string; checksum: string };
    const transfer = this.inbound.get(requestId);
    if (!transfer) return;
    this.inbound.delete(requestId);

    const assembled = reassembleChunks(transfer.chunks, transfer.totalChunks);
    if (!assembled || !verifyFileIntegrity(assembled, checksum)) {
      this.secure.send(createFileAck(requestId, false));
      return;
    }

    const path = this.fileStore.inboundPath(transfer.fileName);
    await this.fileStore.write(path, assembled);
    this.secure.send(createFileAck(requestId, true));
    this.onFileReceived?.({
      fileName: transfer.fileName,
      fileSize: transfer.fileSize,
      mimeType: transfer.mimeType,
      path,
    });
  }

  private onFileAck(message: Message): void {
    const { requestId, success } = message.payload as { requestId: string; success: boolean };
    this.settleOutbound(requestId, {
      success,
      reason: success ? undefined : 'integrity check failed on receiver',
    });
  }

  private settleOutbound(requestId: string, result: SendResult): void {
    const transfer = this.outbound.get(requestId);
    if (!transfer) return;
    this.outbound.delete(requestId);
    transfer.resolve(result);
  }
}
