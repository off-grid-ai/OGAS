// Desktop ambient-sharing integration test - the REAL integration, not a bypass.
// Two real ConnectionManagers pair over a real TCP loopback and connect; then the
// real AmbientShareService, driving the real ConnectionFileSender over
// ConnectionManager A's actual transfer, shares a captured screenshot. The
// asserted artifact is the file that ConnectionManager B writes to its real save
// directory on disk, byte-identical. The only fake is the persistence boundary
// (an in-memory ConnectionStorage); the sockets, transfer, and filesystem are all
// real. Breaking the policy or the sender routing makes this go red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  AmbientShareService,
  emptyPolicy,
  setRule,
  ANY_DESTINATION,
  generateDeviceId,
} from '@easyshare/shared';
import type { AppSettings, PairedDevice, ConnectionState, CaptureEvent } from '@easyshare/shared';

import { ConnectionManager } from '../src/main/connection.ts';
import type { ConnectionStorage } from '../src/main/connection-storage.ts';
import { ConnectionFileSender } from '../src/main/sharing/connection-file-sender.ts';

/** In-memory persistence - the only faked boundary. */
class MemoryStorage implements ConnectionStorage {
  readonly paired: PairedDevice[] = [];
  private readonly settings: AppSettings;
  constructor(settings: AppSettings) {
    this.settings = settings;
  }
  getSettings(): AppSettings {
    return this.settings;
  }
  addPairedDevice(device: PairedDevice): void {
    this.paired.push(device);
  }
}

function settingsFor(deviceName: string, saveDir: string): AppSettings {
  return {
    deviceName,
    deviceId: generateDeviceId(),
    autoAcceptFromPaired: true,
    saveDirectory: saveDir,
    notificationsEnabled: false,
  };
}

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate: () => boolean, tries = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

interface Rig {
  a: ConnectionManager;
  b: ConnectionManager;
  sender: ConnectionFileSender;
  bDeviceId: string;
  bSaveDir: string;
  aCaptureDir: string;
  receivedOnB: string[];
  close: () => Promise<void>;
}

/** Stand up two paired, connected ConnectionManagers over real TCP loopback. */
async function pairedRig(): Promise<Rig> {
  const aCaptureDir = await tmpDir('ogas-a-');
  const bSaveDir = await tmpDir('ogas-b-');
  const storageA = new MemoryStorage(settingsFor('Laptop-A', aCaptureDir));
  const storageB = new MemoryStorage(settingsFor('Laptop-B', bSaveDir));

  const a = new ConnectionManager(storageA, '127.0.0.1');
  const b = new ConnectionManager(storageB, '127.0.0.1');
  await a.start();
  await b.start();

  const sender = new ConnectionFileSender(a);
  const receivedOnB: string[] = [];
  b.onTransferComplete((t) => {
    if (t.type === 'file') receivedOnB.push(t.fileName);
  });

  let aPaired = false;
  let bPaired = false;
  a.onConnectionStateChange((s: ConnectionState) => {
    sender.updateConnection(s);
    if (s.pairingStep === 'success') aPaired = true;
  });
  b.onConnectionStateChange((s: ConnectionState) => {
    if (s.pairingStep === 'success') bPaired = true;
  });
  // Responder auto-answers the pairing prompt with the shared passphrase.
  b.onPairingRequest(() => b.respondToPairing('shared-secret'));

  const bInfo = b.getServerInfo();
  const bDeviceId = bInfo.id;
  // getServerInfo() reports host '' (the app advertises via mDNS); dial loopback.
  await a.connectToDevice({ ...bInfo, host: '127.0.0.1' });
  await a.startPairing(bDeviceId, 'shared-secret');

  const paired = await waitFor(() => aPaired && bPaired);
  assert.ok(paired, 'the two devices should pair over real TCP');

  return {
    a,
    b,
    sender,
    bDeviceId,
    bSaveDir,
    aCaptureDir,
    receivedOnB,
    close: async () => {
      await a.stop();
      await b.stop();
      await fs.rm(aCaptureDir, { recursive: true, force: true });
      await fs.rm(bSaveDir, { recursive: true, force: true });
    },
  };
}

function screenshotEvent(capturePath: string, size: number): CaptureEvent {
  return {
    id: 'cap-1',
    source: 'screenshot',
    path: capturePath,
    fileName: 'shot.png',
    fileSize: size,
    mimeType: 'image/png',
    capturedAt: 1000,
  };
}

test('auto: a captured screenshot lands on the paired device, byte-identical', async () => {
  const rig = await pairedRig();
  try {
    const bytes = Buffer.alloc(120 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    const capturePath = path.join(rig.aCaptureDir, 'shot.png');
    await fs.writeFile(capturePath, bytes);

    const policy = setRule(emptyPolicy(), {
      source: 'screenshot',
      destinationId: ANY_DESTINATION,
      mode: 'auto',
    });
    const svc = new AmbientShareService({
      getPolicy: () => policy,
      getDestinations: () => [{ deviceId: rig.bDeviceId, connected: true }],
      sender: rig.sender,
    });

    await svc.handleCapture(screenshotEvent(capturePath, bytes.length));
    const landed = await waitFor(() => rig.receivedOnB.includes('shot.png'));
    assert.ok(landed, 'B should report receiving shot.png');

    const onDisk = await fs.readFile(path.join(rig.bSaveDir, 'shot.png')).catch(() => null);
    assert.ok(onDisk, 'the file should be written to B save dir');
    assert.ok(onDisk!.equals(bytes), 'received bytes must equal the original');
  } finally {
    await rig.close();
  }
});

test('off: nothing is transferred; B save dir stays empty', async () => {
  const rig = await pairedRig();
  try {
    const capturePath = path.join(rig.aCaptureDir, 'shot.png');
    await fs.writeFile(capturePath, Buffer.from('secret bytes'));

    const off = setRule(emptyPolicy(), {
      source: 'screenshot',
      destinationId: ANY_DESTINATION,
      mode: 'off',
    });
    const svc = new AmbientShareService({
      getPolicy: () => off,
      getDestinations: () => [{ deviceId: rig.bDeviceId, connected: true }],
      sender: rig.sender,
    });

    await svc.handleCapture(screenshotEvent(capturePath, 12));
    await new Promise((r) => setTimeout(r, 150));

    const entries = (await fs.readdir(rig.bSaveDir)).filter((f) => !f.startsWith('.'));
    assert.deepEqual(entries, [], 'off mode must transfer nothing');
    assert.equal(rig.receivedOnB.length, 0, 'B received nothing');
  } finally {
    await rig.close();
  }
});
