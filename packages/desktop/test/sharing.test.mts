// Desktop sharing integration test - the real thing end to end. A capture on
// device A flows through the real AmbientShareService (policy + queue) -> the
// real SessionRegistry (FileSender) -> two real TransferSessions -> a REAL TCP
// loopback socket pair -> the real FsFileStore writing to a REAL temp directory.
// Nothing is faked: the socket is an actual net connection, the filesystem is
// actual disk. The asserted artifact is the file that lands in B's save dir,
// byte-identical. Deleting the policy, the registry routing, or the transfer
// logic makes this go red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'net';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  deriveSharedSecret,
  AmbientShareService,
  SessionRegistry,
  emptyPolicy,
  setRule,
  ANY_DESTINATION,
} from '@easyshare/shared';
import type { CaptureEvent, ReceivedFile } from '@easyshare/shared';

import { FsFileStore } from '../src/main/sharing/fs-file-store.ts';
import { SocketChannel } from '../src/main/sharing/socket-channel.ts';

const SENDER = 'deskA';
const RECEIVER = 'deskB';
const SECRET = deriveSharedSecret('license-key', SENDER, RECEIVER);

/** Bring up a real loopback TCP socket pair (server accepts one client). */
function socketPair(): Promise<{ client: net.Socket; server: net.Socket; close: () => void }> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      const client = net.createConnection(port, '127.0.0.1');
      srv.once('connection', (server) => {
        client.once('connect', () =>
          resolve({
            client,
            server,
            close: () => {
              client.destroy();
              server.destroy();
              srv.close();
            },
          })
        );
        // if connect already fired
        if (!client.connecting) {
          resolve({
            client,
            server,
            close: () => {
              client.destroy();
              server.destroy();
              srv.close();
            },
          });
        }
      });
    });
  });
}

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate: () => boolean, tries = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return predicate();
}

function screenshot(capturePath: string, size: number): CaptureEvent {
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

test('auto: a real screenshot lands in the receiver save dir over real TCP', async () => {
  const sendDir = await tmpDir('ogas-send-');
  const recvDir = await tmpDir('ogas-recv-');
  const { client, server, close } = await socketPair();

  try {
    // A ~200 KB file forces multi-chunk transfer over the real socket.
    const bytes = Buffer.alloc(200 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) & 0xff;
    const capturePath = path.join(sendDir, 'shot.png');
    await fs.writeFile(capturePath, bytes);

    // Receiver: a real registry + real session over the server socket.
    const recvStore = new FsFileStore(recvDir);
    const received: ReceivedFile[] = [];
    const recvRegistry = new SessionRegistry({
      fileStore: recvStore,
      onFileReceived: (_id, f) => received.push(f),
    });
    recvRegistry.connect(SENDER, new SocketChannel(server), SECRET);

    // Sender: registry + AmbientShareService with an auto rule for screenshots.
    const sendStore = new FsFileStore(sendDir);
    const sendRegistry = new SessionRegistry({ fileStore: sendStore });
    sendRegistry.connect(RECEIVER, new SocketChannel(client), SECRET);

    const policy = setRule(emptyPolicy(), {
      source: 'screenshot',
      destinationId: ANY_DESTINATION,
      mode: 'auto',
    });
    const svc = new AmbientShareService({
      getPolicy: () => policy,
      getDestinations: () => [{ deviceId: RECEIVER, connected: true }],
      sender: sendRegistry,
    });

    await svc.handleCapture(screenshot(capturePath, bytes.length));
    await waitFor(() => received.length > 0);

    const landedPath = path.join(recvDir, 'shot.png');
    const landed = await fs.readFile(landedPath).catch(() => null);
    assert.ok(landed, 'file should exist in the receiver save dir');
    assert.ok(landed!.equals(bytes), 'received bytes must equal the original');
  } finally {
    close();
    await fs.rm(sendDir, { recursive: true, force: true });
    await fs.rm(recvDir, { recursive: true, force: true });
  }
});

test('off: nothing is written; the receiver save dir stays empty', async () => {
  const sendDir = await tmpDir('ogas-send-');
  const recvDir = await tmpDir('ogas-recv-');
  const { client, server, close } = await socketPair();

  try {
    const capturePath = path.join(sendDir, 'shot.png');
    await fs.writeFile(capturePath, Buffer.from('secret'));

    const recvStore = new FsFileStore(recvDir);
    const recvRegistry = new SessionRegistry({ fileStore: recvStore });
    recvRegistry.connect(SENDER, new SocketChannel(server), SECRET);

    const sendRegistry = new SessionRegistry({ fileStore: new FsFileStore(sendDir) });
    sendRegistry.connect(RECEIVER, new SocketChannel(client), SECRET);

    const off = setRule(emptyPolicy(), {
      source: 'screenshot',
      destinationId: ANY_DESTINATION,
      mode: 'off',
    });
    const svc = new AmbientShareService({
      getPolicy: () => off,
      getDestinations: () => [{ deviceId: RECEIVER, connected: true }],
      sender: sendRegistry,
    });

    await svc.handleCapture(screenshot(capturePath, 6));
    await new Promise((r) => setTimeout(r, 50));

    const entries = await fs.readdir(recvDir);
    assert.deepEqual(entries, [], 'off mode must write nothing to the receiver');
  } finally {
    close();
    await fs.rm(sendDir, { recursive: true, force: true });
    await fs.rm(recvDir, { recursive: true, force: true });
  }
});

test('registry: sendFile to an unknown device returns false (no session)', async () => {
  const registry = new SessionRegistry({ fileStore: new FsFileStore(await tmpDir('ogas-x-')) });
  const ok = await registry.sendFile('ghost', '/nope', 'x.png', 'image/png');
  assert.equal(ok, false, 'no session for the device -> send fails cleanly');
  assert.deepEqual(registry.connectedDeviceIds(), [], 'no devices connected');
});
