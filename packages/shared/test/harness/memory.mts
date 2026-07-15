// Behavior-faithful in-memory fakes for the two device boundaries a transfer
// crosses: the socket (ByteChannel) and the disk (FileStore). These are the
// ONLY things faked in the ambient-sharing integration tests - everything above
// them (policy, queue, session state machine, framing, encryption, chunking,
// reassembly, integrity) is the real shared code, so a bug in any of it makes
// the file fail to land and the test go red.

import type { ByteChannel, FileStore } from '@easyshare/shared';

/** An in-memory filesystem that really stores and returns bytes. */
export class InMemoryFileStore implements FileStore {
  readonly files = new Map<string, Uint8Array>();
  private readonly inboundDir: string;

  constructor(inboundDir: string) {
    this.inboundDir = inboundDir;
  }

  async read(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new Error(`ENOENT: ${path}`);
    return data;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }

  inboundPath(fileName: string): string {
    return `${this.inboundDir}/${fileName}`;
  }

  /** Test helper: place a file as if the OS captured it. */
  seed(path: string, data: Uint8Array): void {
    this.files.set(path, data);
  }
}

/** Optional per-frame transform, used to simulate on-wire corruption. */
export type FrameTransform = (frame: Uint8Array) => Uint8Array;

/**
 * A pair of ByteChannels wired to each other, delivering asynchronously (via
 * microtasks) like a real socket. `transformAToB` can tamper with frames going
 * from side A to side B to exercise the integrity path.
 */
export function createChannelPair(transformAToB?: FrameTransform): {
  a: ByteChannel;
  b: ByteChannel;
} {
  let handlerA: ((data: Uint8Array) => void) | null = null;
  let handlerB: ((data: Uint8Array) => void) | null = null;

  const a: ByteChannel = {
    send(frame) {
      const out = transformAToB ? transformAToB(frame) : frame;
      queueMicrotask(() => handlerB?.(out));
    },
    onData(handler) {
      handlerA = handler;
    },
  };

  const b: ByteChannel = {
    send(frame) {
      queueMicrotask(() => handlerA?.(frame));
    },
    onData(handler) {
      handlerB = handler;
    },
  };

  return { a, b };
}

/** Deterministic pseudo-random bytes (no Math.random) for stable test files. */
export function makeBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

/** True iff two byte arrays are identical. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Await until `predicate()` is true or `tries` macrotask turns elapse. */
export async function waitFor(predicate: () => boolean, tries = 50): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return predicate();
}
