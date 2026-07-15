// Integration test for the encrypted message channel. Two SecureChannels over a
// real in-memory channel pair (the only fake is the socket). Asserts a message
// round-trips decrypted-and-equal, and that a tampered frame is dropped, never
// delivered. Deleting the encrypt/decrypt wiring makes these go red.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveSharedSecret, SecureChannel } from '../dist/index.js';
import type { Message } from '../dist/index.js';
import { createChannelPair, type FrameTransform } from './harness/memory.mts';

const SECRET = deriveSharedSecret('license-key', 'devA', 'devB');

function textMessage(content: string): Message {
  return { type: 'text', id: 'm1', timestamp: 1, payload: { content } };
}

test('secure channel: a message round-trips decrypted and equal', async () => {
  const { a, b } = createChannelPair();
  const received: Message[] = [];
  const chanA = new SecureChannel(a, SECRET, () => {});
  // eslint-disable-next-line no-new -- B receives via its handler
  new SecureChannel(b, SECRET, (m) => received.push(m));

  chanA.send(textMessage('hello over the wire'));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'text');
  assert.equal((received[0].payload as { content: string }).content, 'hello over the wire');
});

test('secure channel: the plaintext never appears on the raw wire', async () => {
  // Capture the raw bytes A puts on the wire; the secret content must not be in them.
  const captured: Uint8Array[] = [];
  const capture: FrameTransform = (frame) => {
    captured.push(frame);
    return frame;
  };
  const { a } = createChannelPair(capture);
  const chanA = new SecureChannel(a, SECRET, () => {});

  chanA.send(textMessage('TOP-SECRET-PLAINTEXT'));
  await new Promise((r) => setTimeout(r, 0));

  const wire = Buffer.concat(captured.map((f) => Buffer.from(f))).toString('utf8');
  assert.equal(wire.includes('TOP-SECRET-PLAINTEXT'), false, 'plaintext must not be on the wire');
});

test('secure channel: a tampered frame is dropped, not delivered', async () => {
  const tamper: FrameTransform = (frame) => {
    const copy = frame.slice();
    copy[copy.length - 1] ^= 0xff; // corrupt the ciphertext
    return copy;
  };
  const { a, b } = createChannelPair(tamper);
  const received: Message[] = [];
  const chanA = new SecureChannel(a, SECRET, () => {});
  // eslint-disable-next-line no-new -- B receives via its handler
  new SecureChannel(b, SECRET, (m) => received.push(m));

  chanA.send(textMessage('should never arrive'));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(received.length, 0, 'a corrupted frame must not be delivered');
});
