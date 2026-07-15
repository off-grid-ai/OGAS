// SecureChannel - the encrypted message pipe both the apps and TransferSession
// put their post-pairing traffic through. It turns a raw ByteChannel (a socket)
// into a Message channel where every message is NaCl-encrypted with the pairing's
// shared secret and length-prefixed so a byte stream splits back into whole
// messages. This is the single place transport encryption lives, so the desktop
// and mobile connection code, and the file-transfer session, all share one wire.
//
// Framing on the wire: [uint32 BE frameLen][ createEncryptedFrame(cipher, nonce) ]
// where the inner frame is [nonceLen(1)][nonce][ciphertext]. Pairing handshake
// messages are exchanged in the clear (the shared secret doesn't exist yet); the
// apps switch to a SecureChannel once pairing derives the secret.

import type { Message } from '../types';
import {
  encryptMessage,
  decryptMessage,
  createEncryptedFrame,
  parseEncryptedFrame,
} from '../protocol';
import type { ByteChannel } from './ports';

/**
 * Reassembles a length-prefixed byte stream into whole encrypted frames.
 * Exported so the file-transfer session and the apps share one reader.
 */
export class FrameReader {
  private buf: Uint8Array = new Uint8Array(0);

  append(data: Uint8Array): void {
    const next = new Uint8Array(this.buf.length + data.length);
    next.set(this.buf);
    next.set(data, this.buf.length);
    this.buf = next;
  }

  /** Pull the next complete frame, or null if it is not yet fully buffered. */
  next(): Uint8Array | null {
    if (this.buf.length < 4) return null;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset);
    const frameLen = view.getUint32(0, false);
    if (this.buf.length < 4 + frameLen) return null;
    const frame = this.buf.slice(4, 4 + frameLen);
    this.buf = this.buf.slice(4 + frameLen);
    return frame;
  }
}

/** Encrypt + length-prefix a message into a single wire frame. */
export function frameMessage(message: Message, secretKey: string): Uint8Array {
  const { encrypted, nonce } = encryptMessage(message, secretKey);
  const inner = createEncryptedFrame(encrypted, nonce);
  const out = new Uint8Array(4 + inner.length);
  new DataView(out.buffer).setUint32(0, inner.length, false);
  out.set(inner, 4);
  return out;
}

/**
 * An encrypted Message channel over a raw ByteChannel. Construct it with the
 * shared secret and a handler; `send` puts an encrypted message on the wire, and
 * decrypted inbound messages are delivered to the handler. A frame that fails to
 * decrypt (tampered/garbage) is dropped, never delivered.
 */
export class SecureChannel {
  private readonly channel: ByteChannel;
  private readonly secretKey: string;
  private readonly onMessage: (message: Message) => void;
  private readonly reader = new FrameReader();

  constructor(
    channel: ByteChannel,
    secretKey: string,
    onMessage: (message: Message) => void
  ) {
    this.channel = channel;
    this.secretKey = secretKey;
    this.onMessage = onMessage;
    this.channel.onData((data) => this.ingest(data));
  }

  /** Encrypt, frame, and transmit a message. */
  send(message: Message): void {
    this.channel.send(frameMessage(message, this.secretKey));
  }

  private ingest(data: Uint8Array): void {
    this.reader.append(data);
    let frame: Uint8Array | null;
    while ((frame = this.reader.next()) !== null) {
      const parsed = parseEncryptedFrame(frame);
      if (!parsed) continue;
      const message = decryptMessage(parsed.encrypted, parsed.nonce, this.secretKey);
      if (message) this.onMessage(message);
    }
  }
}
