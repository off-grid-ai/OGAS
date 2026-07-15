// Display helpers that resolve a name/size from any file transfer, handling both
// the single-file and multi-file shapes so callers don't have to narrow the
// union at every render site. Defined once, used by every transfer view.

import type { FileTransfer, FilesTransfer } from '@easyshare/shared';

/** A human name for a file transfer: the file name, or "N files" for a batch. */
export function transferFileName(transfer: FileTransfer | FilesTransfer): string {
  return transfer.type === 'file' ? transfer.fileName : `${transfer.files.length} files`;
}

/** Total byte size of a file transfer, whether single-file or a batch. */
export function transferFileSize(transfer: FileTransfer | FilesTransfer): number {
  return transfer.type === 'file' ? transfer.fileSize : transfer.totalSize;
}
