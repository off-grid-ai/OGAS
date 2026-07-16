// The narrow storage contract ConnectionManager actually depends on. Extracted so
// ConnectionManager depends on an interface, not the electron-coupled
// StorageService concrete (DIP). StorageService satisfies this structurally; a
// headless test supplies an in-memory implementation, which is what lets the
// connection layer be driven in a real integration test without electron.

import type { AppSettings, PairedDevice } from '@easyshare/shared';

export interface ConnectionStorage {
  getSettings(): AppSettings;
  addPairedDevice(device: PairedDevice): void;
}
