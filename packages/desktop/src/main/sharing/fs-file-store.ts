// FsFileStore - adapts the Node filesystem to the shared FileStore port. Reads
// files to send, writes received files into the user's save directory, and names
// the inbound path. The save directory is the one the capture watcher must
// ignore (anti-loop), so it is the single source of that path.

import { promises as fs } from 'fs';
import * as path from 'path';
import type { FileStore } from '@easyshare/shared';

export class FsFileStore implements FileStore {
  private readonly saveDir: string;

  constructor(saveDir: string) {
    this.saveDir = saveDir;
  }

  async read(filePath: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(filePath));
  }

  async write(filePath: string, data: Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(data));
  }

  inboundPath(fileName: string): string {
    // Use only the basename so a peer can't write outside the save dir.
    return path.join(this.saveDir, path.basename(fileName));
  }
}
