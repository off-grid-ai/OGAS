// Integration tests for the shared ambient-sharing layer. The real
// AmbientShareService + policy + queue run over a behavior-faithful fake
// transport (FakeTransport = the FileSender boundary to the app's transfer).
// The observable outcome asserted is which files the transport delivered, plus
// the user-facing prompt for 'ask'. The REAL end-to-end (bytes landing over a
// real socket) is proven in the desktop integration test that drives the actual
// ConnectionManager. Deleting the policy or the queue makes these go red.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AmbientShareService,
  emptyPolicy,
  setRule,
  ANY_DESTINATION,
  shouldEmit,
  createEmitGuardState,
} from '../dist/index.js';
import type { CaptureEvent, DestinationState, SharePolicy, SharePrompt } from '../dist/index.js';
import { FakeTransport, waitFor } from './harness/transport.mts';

const RECEIVER = 'devB';

function screenshot(): CaptureEvent {
  return {
    id: 'cap-1',
    source: 'screenshot',
    path: '/A/captures/shot.png',
    fileName: 'shot.png',
    fileSize: 150 * 1024,
    mimeType: 'image/png',
    capturedAt: 1_000,
  };
}

function service(
  transport: FakeTransport,
  policy: SharePolicy,
  destinations: DestinationState[],
  onPrompt?: (p: SharePrompt) => void
): AmbientShareService {
  return new AmbientShareService({
    getPolicy: () => policy,
    getDestinations: () => destinations,
    sender: transport,
    onPrompt,
    now: () => 5_000,
  });
}

test('auto: a captured screenshot is delivered to a connected device', async () => {
  const transport = new FakeTransport([RECEIVER]);
  const policy = setRule(emptyPolicy(), {
    source: 'screenshot',
    destinationId: ANY_DESTINATION,
    mode: 'auto',
  });

  await service(transport, policy, [{ deviceId: RECEIVER, connected: true }]).handleCapture(
    screenshot()
  );

  assert.equal(transport.count(RECEIVER), 1, 'auto should deliver to the connected device');
  assert.equal(transport.delivered[0].path, '/A/captures/shot.png');
});

test('off: nothing is delivered; flipping the rule to auto delivers (guard is real)', async () => {
  const transport = new FakeTransport([RECEIVER]);
  const dest = [{ deviceId: RECEIVER, connected: true }];

  const off = setRule(emptyPolicy(), {
    source: 'screenshot',
    destinationId: ANY_DESTINATION,
    mode: 'off',
  });
  await service(transport, off, dest).handleCapture(screenshot());
  assert.equal(transport.count(), 0, 'off must deliver nothing');

  const auto = setRule(off, { source: 'screenshot', destinationId: ANY_DESTINATION, mode: 'auto' });
  await service(transport, auto, dest).handleCapture(screenshot());
  assert.equal(transport.count(), 1, 'auto must deliver');
});

test('ask: nothing is delivered until the user confirms', async () => {
  const transport = new FakeTransport([RECEIVER]);
  const policy = setRule(emptyPolicy(), {
    source: 'screenshot',
    destinationId: ANY_DESTINATION,
    mode: 'ask',
  });

  let prompt: SharePrompt | undefined;
  await service(transport, policy, [{ deviceId: RECEIVER, connected: true }], (p) => {
    prompt = p;
  }).handleCapture(screenshot());

  assert.ok(prompt, 'ask mode must surface a prompt');
  assert.equal(transport.count(), 0, 'nothing delivered before confirm');

  const ok = await prompt!.confirm();
  assert.equal(ok, true, 'confirm resolves true once the peer accepts');
  assert.equal(transport.count(RECEIVER), 1, 'file delivered after confirm');
});

test('per-device override: auto to my laptop, off to a friend', async () => {
  const MINE = 'my-laptop';
  const FRIEND = 'friend-phone';
  const transport = new FakeTransport([MINE, FRIEND]);
  let policy = setRule(emptyPolicy(), {
    source: 'screenshot',
    destinationId: ANY_DESTINATION,
    mode: 'auto',
  });
  policy = setRule(policy, { source: 'screenshot', destinationId: FRIEND, mode: 'off' });

  await service(transport, policy, [
    { deviceId: MINE, connected: true },
    { deviceId: FRIEND, connected: true },
  ]).handleCapture(screenshot());

  assert.equal(transport.count(MINE), 1, 'auto to my laptop');
  assert.equal(transport.count(FRIEND), 0, 'off to the friend (device rule overrides the default)');
});

test('offline + queue: held while disconnected, delivered on reconnect', async () => {
  const transport = new FakeTransport([]); // receiver offline
  const policy: SharePolicy = {
    ...setRule(emptyPolicy('queue'), {
      source: 'screenshot',
      destinationId: ANY_DESTINATION,
      mode: 'auto',
    }),
    offlineBehavior: 'queue',
  };
  const svc = service(transport, policy, [{ deviceId: RECEIVER, connected: false }]);

  await svc.handleCapture(screenshot());
  assert.equal(transport.count(), 0, 'offline: nothing delivered yet');
  assert.equal(svc.pending.length, 1, 'the share is queued');

  transport.bringOnline(RECEIVER);
  const delivered = await waitFor(() => transport.count(RECEIVER) > 0);

  assert.ok(delivered, 'queued file is delivered after reconnect');
  assert.equal(svc.pending.length, 0, 'queue cleared after a successful drain');
});

test('offline + skip: dropped, not queued', async () => {
  const transport = new FakeTransport([]);
  const policy = setRule(emptyPolicy('skip'), {
    source: 'screenshot',
    destinationId: ANY_DESTINATION,
    mode: 'auto',
  });
  const svc = service(transport, policy, [{ deviceId: RECEIVER, connected: false }]);

  await svc.handleCapture(screenshot());
  assert.equal(svc.pending.length, 0, 'skip must not queue');

  transport.bringOnline(RECEIVER);
  await waitFor(() => transport.count() > 0, 5);
  assert.equal(transport.count(), 0, 'nothing is delivered on reconnect (it was skipped)');
});

test('anti-loop: a file already in the inbound dir is not re-emitted for sharing', () => {
  const guard = createEmitGuardState();
  const options = { ignoredPathPrefixes: ['/B/inbound'] };

  const inbound: CaptureEvent = {
    id: 'inbound-1',
    source: 'file',
    path: '/B/inbound/shot.png',
    fileName: 'shot.png',
    fileSize: 10,
    mimeType: 'image/png',
    capturedAt: 2_000,
  };
  assert.equal(shouldEmit(inbound, guard, options), false, 'inbound file must be ignored');

  const real: CaptureEvent = { ...inbound, id: 'real-1', path: '/A/captures/shot.png' };
  assert.equal(shouldEmit(real, guard, options), true, 'a real capture must emit');
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
  assert.equal(
    shouldEmit({ ...event, capturedAt: 3_500 }, guard, { dedupWindowMs: 10_000 }),
    false,
    'duplicate within window suppressed'
  );
  assert.equal(
    shouldEmit({ ...event, capturedAt: 20_000 }, guard, { dedupWindowMs: 10_000 }),
    true,
    're-emit after the window'
  );
});
