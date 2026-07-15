// SocketChannel - adapts a Node TCP socket to the shared ByteChannel port, so a
// TransferSession can run over the desktop's real connection. This is the one
// place raw socket bytes meet the shared encrypted framing: send() writes a
// frame; the socket's 'data' events feed onData(). No transfer logic here.

import type { Socket } from 'net';
import type { ByteChannel } from '@easyshare/shared';

export class SocketChannel implements ByteChannel {
  private readonly socket: Socket;
  private handler: ((data: Uint8Array) => void) | null = null;

  constructor(socket: Socket) {
    this.socket = socket;
    this.socket.on('data', (data: Buffer) => {
      this.handler?.(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    });
  }

  send(frame: Uint8Array): void {
    this.socket.write(Buffer.from(frame));
  }

  onData(handler: (data: Uint8Array) => void): void {
    this.handler = handler;
  }
}
