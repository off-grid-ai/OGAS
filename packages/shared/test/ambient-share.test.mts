// Integration tests for ambient sharing. Two real devices (TransferSessions)
// talk over an in-memory channel pair; the AmbientShareService drives sends from
// the real policy + queue. The ONLY fakes are the socket (ByteChannel) and the
// disk (FileStore). The asserted terminal artifact is always the file that lands
// on the RECEIVER, byte-identical - never a spy or an internal field. Deleting
// the policy, the chunking, or the integrity check makes these go red.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Import the REAL code through the built package entry (the source uses
// extensionless directory imports that Node's ESM runtime can't resolve; the
// bundle is the same code). Nothing here is mocked.
import {
  deriveSharedSecret,
  TransferSession,
  AmbientShareService,
  emptyPolicy,
  setRule,
  ANY_DESTINATION,
  shouldEmit,
  createEmitGuardState,
} from '../dist/index.js';
import type {
  ReceivedFile,
  FileSender,
  SharePrompt,
  CaptureEvent,
  DestinationState,
  SharePolicy,
} from '../dist/index.js';
import {
  InMemoryFileStore,
  createChannelPair,
  makeBytes,
  bytesEqual,
  waitFor,
  type FrameTransform,
} from './harness/memory.mts';

const SENDER = 'devA';
const RECEIVER = 'devB';
const SECRET = deriveSharedSecret('shared-license-key', SENDER, RECEIVER);

// A 150 KB file forces multi-chunk transfer (3 x 64 KB), exercising chunking +
// reassembly rather than a trivial single-chunk path.
const CAPTURE_PATH = '/A/captures/shot.png';
const CAPTURE_BYTES = makeBytes(150 * 1024, 7);

function screenshot(): CaptureEvent {
  return {
    id: 'cap-1',
    source: 'screenshot',
    path: CAPTURE_PATH,
    fileName: 'shot.png',
    fileSize: CAPTURE_BYTES.length,
    mimeType: 'image/png',
    capturedAt: 1_000,
  };
}

interface World {
  fsB: InMemoryFileStore;
  received: ReceivedFile[];
  sender: FileSender;
  reconnect: (deviceId: string) => void;
  setConnected: (ids: string[]) => void;
}

function makeWorld(transformAToB?: FrameTransform): World {
  const fsA = new InMemoryFileStore('/A/inbound');
  const fsB = new InMemoryFileStore('/B/inbound');
  fsA.seed(CAPTURE_PATH, CAPTURE_BYTES);

  const { a, b } = createChannelPair(transformAToB);
  const received: ReceivedFile[] = [];

  // Both real sessions. Sender side sends; receiver side reassembles + writes.
  const sessionA = new TransferSession({ channel: a, fileStore: fsA, secretKey: SECRET });
  // eslint-disable-next-line no-new -- receiver wires itself via its channel handler
  new TransferSession({
    channel: b,
    fileStore: fsB,
    secretKey: SECRET,
    onFileReceived: (f) => received.push(f),
  });

  let connected: string[] = [RECEIVER];
  const reconnectHandlers: Array<(deviceId: string) => void> = [];

  const sender: FileSender = {
    connectedDeviceIds: () => connected,
    sendFile: async (_deviceId, path, fileName, mimeType) =>
      (await sessionA.sendFile(path, fileName, mimeType)).success,
    onReconnect: (handler) => {
      reconnectHandlers.push(handler);
      return () => {};
    },
  };

  return {
    fsB,
    received,
    sender,
    reconnect: (id) => reconnectHandlers.forEach((h) => h(id)),
    setConnected: (ids) => {
      connected = ids;
    },
  };
}

function service(
  world: World,
  policy: SharePolicy,
  destinations: DestinationState[],
  onPrompt?: (p: SharePrompt) => void
): AmbientShareService {
  return new AmbientShareService({
    getPolicy: () => policy,
    getDestinations: () => destinations,
    sender: world.sender,
    onPrompt,
    now: () => 5_000,
  });
}

test('auto: a captured screenshot lands on the receiver byte-identical', async () => {
  const world = makeWorld();
  const policy = setRule(emptyPolicy(), {
    source: 'screenshot',
    destinationId: ANY_DESTINATION,
    mode: 'auto',
  });
  const svc = service(world, policy, [{ deviceId: RECEIVER, connected: true }]);

  await svc.handleCapture(screenshot());

  const landed = world.fsB.files.get('/B/inbound/shot.png');
  assert.ok(landed, 'file should exist on the receiver');
  assert.ok(bytesEqual(landed, CAPTURE_BYTES), 'received bytes must equal the original');
  assert.equal(world.received.length, 1);
});

test('off: nothing is sent; flipping the rule to auto makes it land (guard is real)', async () => {
  const world = makeWorld();
  const dest = [{ deviceId: RECEIVER, connected: true }];

  const off = setRule(emptyPolicy(), {
    source: 'screenshot',
    destinationId: ANY_DESTINATION,
    mode: 'off',
  });
  await service(world, off, dest).handleCapture(screenshot());
  assert.equal(world.fsB.files.has('/B/inbound/shot.png'), false, 'off must not send');

  // Falsify: same world, same capture, mode auto -> it must now land.
  const auto = setRule(off, {
    source: 'screenshot',
    destinationId: ANY_DESTINATION,
    mode: 'auto',
  });
  await service(world, auto, dest).handleCapture(screenshot());
  assert.ok(world.fsB.files.get('/B/inbound/shot.png'), 'auto must send');
});

test('ask: no bytes move until the user confirms, then the file lands', async () => {
  const world = makeWorld();
  const policy = setRule(emptyPolicy(), {
    source: 'screenshot',
    destinationId: ANY_DESTINATION,
    mode: 'ask',
  });

  let prompt: SharePrompt | undefined;
  const svc = service(world, policy, [{ deviceId: RECEIVER, connected: true }], (p) => {
    prompt = p;
  });

  await svc.handleCapture(screenshot());
  assert.ok(prompt, 'ask mode must surface a prompt');
  assert.equal(world.fsB.files.has('/B/inbound/shot.png'), false, 'nothing before confirm');

  const ok = await prompt!.confirm();
  assert.equal(ok, true, 'confirm resolves true once the peer verifies receipt');
  assert.ok(world.fsB.files.get('/B/inbound/shot.png'), 'file lands after confirm');
});

test('offline + queue: held while disconnected, drains and lands on reconnect', async () => {
  const world = makeWorld();
  world.setConnected([]); // receiver not reachable
  const policy: SharePolicy = {
    ...setRule(emptyPolicy('queue'), {
      source: 'screenshot',
      destinationId: ANY_DESTINATION,
      mode: 'auto',
    }),
    offlineBehavior: 'queue',
  };
  const svc = service(world, policy, [{ deviceId: RECEIVER, connected: false }]);

  await svc.handleCapture(screenshot());
  assert.equal(world.fsB.files.has('/B/inbound/shot.png'), false, 'offline: nothing sent yet');
  assert.equal(svc.pending.length, 1, 'the share is queued');

  // Reconnect -> the service drains the queue.
  world.setConnected([RECEIVER]);
  world.reconnect(RECEIVER);
  const landed = await waitFor(() => world.fsB.files.has('/B/inbound/shot.png'));

  assert.ok(landed, 'queued file lands after reconnect');
  assert.ok(bytesEqual(world.fsB.files.get('/B/inbound/shot.png')!, CAPTURE_BYTES));
  assert.equal(svc.pending.length, 0, 'queue is cleared after a successful drain');
});

test('integrity: a corrupted chunk on the wire means NO file is written', async () => {
  // Corrupt the 2nd frame A->B (the first file chunk). The request (frame 0) and
  // the rest arrive intact, so pairing/accept succeed but reassembly is short a
  // chunk -> the receiver must reject and write nothing.
  let frameIndex = 0;
  const tamper: FrameTransform = (frame) => {
    const corrupt = frameIndex === 1;
    frameIndex += 1;
    if (!corrupt) return frame;
    const copy = frame.slice();
    copy[copy.length - 1] ^= 0xff; // flip a ciphertext byte
    return copy;
  };
  const world = makeWorld(tamper);
  const policy = setRule(emptyPolicy(), {
    source: 'screenshot',
    destinationId: ANY_DESTINATION,
    mode: 'auto',
  });

  await service(world, policy, [{ deviceId: RECEIVER, connected: true }]).handleCapture(
    screenshot()
  );

  assert.equal(
    world.fsB.files.has('/B/inbound/shot.png'),
    false,
    'a corrupted transfer must never write a partial/wrong file'
  );
  assert.equal(world.received.length, 0, 'no received-file event on integrity failure');
});

test('anti-loop: a file already in the inbound dir is not re-emitted for sharing', () => {
  const inbound = new InMemoryFileStore('/B/inbound');
  const guard = createEmitGuardState();
  const options = { ignoredPathPrefixes: ['/B/inbound'] };

  const receivedFile: CaptureEvent = {
    id: 'inbound-1',
    source: 'file',
    path: inbound.inboundPath('shot.png'), // '/B/inbound/shot.png'
    fileName: 'shot.png',
    fileSize: 10,
    mimeType: 'image/png',
    capturedAt: 2_000,
  };
  assert.equal(shouldEmit(receivedFile, guard, options), false, 'inbound file must be ignored');

  // Falsify: a genuine capture outside the inbound dir IS emitted.
  const realCapture: CaptureEvent = { ...receivedFile, id: 'real-1', path: '/A/captures/shot.png' };
  assert.equal(shouldEmit(realCapture, guard, options), true, 'real capture must emit');
});

test('anti-storm: the same capture inside the dedup window is emitted once', () => {
  const guard = createEmitGuardState();
  const event: CaptureEvent = {
    id: 'burst-1',
    source: 'screenshot',
    path: '/A/captures/shot.png',
    fileName: 'shot.png',
    fileSize: 10,
    mimeType: 'image/png',
    capturedAt: 3_000,
  };

  assert.equal(shouldEmit(event, guard, { dedupWindowMs: 10_000 }), true, 'first emit accepted');
  const dup = { ...event, capturedAt: 3_500 };
  assert.equal(shouldEmit(dup, guard, { dedupWindowMs: 10_000 }), false, 'duplicate suppressed');
  const later = { ...event, capturedAt: 20_000 };
  assert.equal(shouldEmit(later, guard, { dedupWindowMs: 10_000 }), true, 're-emit after window');
});
