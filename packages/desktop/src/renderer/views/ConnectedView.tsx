import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  IconSend,
  IconFile,
  IconUnlink,
  IconDeviceMobile,
  IconDeviceDesktop,
  IconUpload,
  IconCheck,
  IconArrowUp,
  IconArrowDown,
  IconX,
  IconCopy,
  IconFolderOpen,
} from '@tabler/icons-react';
import type { DeviceInfo, TransferProgress, TransferQueueItem, Transfer, FileTransfer } from '@easyshare/shared';
import { formatTransferSpeed, formatDuration, formatProgressInfo } from '@easyshare/shared';
import { transferFileName, transferFileSize } from '../lib/transfer-display';
import { ProgressBar } from '../components/ProgressBar';
import { BorderBeam } from '../components/BorderBeam';

interface ConnectedViewProps {
  device: DeviceInfo;
  onDisconnect: () => void;
  onSendText: (text: string) => void;
  onSendFile: (filePath: string) => void;
  onSendFiles?: (filePaths: string[]) => void;
  onCancelTransfer?: () => void;
  currentProgress: TransferProgress | null;
  transfers: Transfer[];
  transferQueue?: TransferQueueItem[];
}

export function ConnectedView({
  device,
  onDisconnect,
  onSendText,
  onSendFile,
  onSendFiles,
  onCancelTransfer,
  currentProgress,
  transfers,
  transferQueue = [],
}: ConnectedViewProps) {
  const [textInput, setTextInput] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedTransfer, setSelectedTransfer] = useState<Transfer | null>(null);
  const Icon = device.platform === 'android' ? IconDeviceMobile : IconDeviceDesktop;

  // Show recent transfers (all transfers for now - can filter by device later)
  const sessionTransfers = transfers.slice(0, 10);

  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (textInput.trim()) {
      onSendText(textInput.trim());
      setTextInput('');
    }
  };

  const handleSelectFile = async () => {
    const filePaths = await window.api.selectFiles();
    if (filePaths && filePaths.length > 0) {
      if (filePaths.length === 1) {
        onSendFile(filePaths[0]);
      } else if (onSendFiles) {
        onSendFiles(filePaths);
      } else {
        // Fallback: send files one by one
        for (const filePath of filePaths) {
          onSendFile(filePath);
        }
      }
    }
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const filePaths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i] as File & { path?: string };
        if (file.path) {
          filePaths.push(file.path);
        }
      }

      if (filePaths.length === 1) {
        onSendFile(filePaths[0]);
      } else if (filePaths.length > 1 && onSendFiles) {
        onSendFiles(filePaths);
      } else {
        // Fallback: send files one by one
        for (const filePath of filePaths) {
          onSendFile(filePath);
        }
      }
    }
  }, [onSendFile, onSendFiles]);

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="max-w-3xl mx-auto">
        {/* Connected device card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative mb-8 p-6 rounded-2xl bg-neutral-900/60 border border-neutral-800 overflow-hidden"
        >
          <BorderBeam duration={6} />

          <div className="flex items-center justify-between relative z-10">
            <div className="flex items-center gap-4">
              <div className="p-4 rounded-xl bg-neutral-800/80">
                <Icon size={32} stroke={1.5} className="text-white" />
              </div>
              <div>
                <h2 className="text-xl font-light text-white">{device.name}</h2>
                <p className="text-neutral-500 flex items-center gap-2 mt-1">
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  Connected
                </p>
              </div>
            </div>

            <button
              onClick={onDisconnect}
              className="flex items-center gap-2 px-4 py-2 rounded-lg
                text-neutral-400 hover:text-white hover:bg-neutral-800
                transition-colors duration-200"
            >
              <IconUnlink size={18} />
              <span className="text-sm">Disconnect</span>
            </button>
          </div>
        </motion.div>

        {/* Transfer progress / queue */}
        {transferQueue.length > 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8 p-4 rounded-xl bg-neutral-900/60 border border-neutral-800 space-y-2"
          >
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-neutral-500 uppercase tracking-wide">
                Sending {transferQueue.filter((q) => q.status === 'completed').length}/{transferQueue.length} files
              </p>
              {onCancelTransfer && (
                <button
                  onClick={onCancelTransfer}
                  className="text-xs text-neutral-500 hover:text-red-400 transition-colors"
                >
                  Cancel
                </button>
              )}
            </div>
            {transferQueue.map((item) => (
              <div key={item.id} className="flex items-center gap-3 py-1.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <p className={`text-sm truncate ${
                      item.status === 'pending' ? 'text-neutral-500' :
                      item.status === 'failed' ? 'text-red-400' : 'text-white'
                    }`}>
                      {item.fileName}
                    </p>
                    <span className={`text-xs ml-2 flex-shrink-0 ${
                      item.status === 'completed' ? 'text-green-400' :
                      item.status === 'failed' ? 'text-red-400' :
                      item.status === 'transferring' ? 'text-blue-400' :
                      'text-neutral-600'
                    }`}>
                      {item.status === 'completed' ? '✓' :
                       item.status === 'failed' ? '✗' :
                       item.status === 'transferring' ? `${item.progress}%` :
                       'Queued'}
                    </span>
                  </div>
                  {item.status === 'transferring' && (
                    <>
                      <div className="h-1 rounded-full bg-neutral-800 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-blue-500 transition-all duration-300"
                          style={{ width: `${item.progress}%` }}
                        />
                      </div>
                      {currentProgress && (
                        <p className="text-xs text-neutral-500 mt-1">{formatProgressInfo(currentProgress)}</p>
                      )}
                    </>
                  )}
                  {item.status === 'completed' && (
                    <div className="h-1 rounded-full bg-green-500/30">
                      <div className="h-full rounded-full bg-green-500 w-full" />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </motion.div>
        ) : currentProgress ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8 p-4 rounded-xl bg-neutral-900/60 border border-neutral-800"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <ProgressBar
                  progress={currentProgress.percentage}
                  label={currentProgress.currentFile || 'Transferring...'}
                  info={formatProgressInfo(currentProgress)}
                />
              </div>
              {onCancelTransfer && (
                <button
                  onClick={onCancelTransfer}
                  className="mt-0.5 p-1 text-neutral-500 hover:text-red-400 transition-colors flex-shrink-0"
                  title="Cancel transfer"
                >
                  <IconX size={16} />
                </button>
              )}
            </div>
          </motion.div>
        ) : null}

        {/* Recent transfers */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="mb-8"
        >
          <h3 className="text-sm font-medium text-neutral-500 uppercase tracking-wide mb-4">
            Recent Activity
          </h3>
          {sessionTransfers.length > 0 ? (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {sessionTransfers.map((transfer) => (
                <motion.div
                  key={transfer.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  onClick={() => setSelectedTransfer(transfer)}
                  className="flex items-center gap-3 p-3 rounded-lg bg-neutral-900/40 border border-neutral-800/50 cursor-pointer hover:bg-neutral-800/50 transition-colors"
                >
                  <div className={`p-2 rounded-lg ${
                    transfer.direction === 'send'
                      ? 'bg-blue-500/20 text-blue-400'
                      : 'bg-green-500/20 text-green-400'
                  }`}>
                    {transfer.direction === 'send' ? (
                      <IconArrowUp size={16} />
                    ) : (
                      <IconArrowDown size={16} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">
                      {transfer.type === 'text'
                        ? (transfer.content?.slice(0, 50) + (transfer.content && transfer.content.length > 50 ? '...' : ''))
                        : transferFileName(transfer)}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {transfer.type === 'text' ? 'Text' : 'File'} • {formatTime(transfer.timestamp)}
                    </p>
                  </div>
                  <IconCheck size={16} className="text-green-500" />
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="p-6 rounded-xl bg-neutral-900/30 border border-neutral-800/50 text-center">
              <p className="text-neutral-500 text-sm">No activity yet</p>
              <p className="text-neutral-600 text-xs mt-1">Send text or files to see them here</p>
            </div>
          )}
        </motion.div>

        {/* Send file section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="mb-8"
        >
          <h3 className="text-sm font-medium text-neutral-500 uppercase tracking-wide mb-4">
            Send File
          </h3>

          <div
            onClick={handleSelectFile}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`
              w-full p-8 rounded-xl border-2 border-dashed cursor-pointer
              transition-all duration-200 group
              ${isDragOver
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-neutral-800 hover:border-neutral-700 hover:bg-neutral-900/30'
              }
            `}
          >
            <div className="flex flex-col items-center gap-3">
              <div className={`p-3 rounded-full transition-colors ${
                isDragOver ? 'bg-blue-500/20' : 'bg-neutral-800 group-hover:bg-neutral-700'
              }`}>
                <IconUpload
                  size={24}
                  className={`transition-colors ${
                    isDragOver ? 'text-blue-400' : 'text-neutral-500 group-hover:text-neutral-400'
                  }`}
                />
              </div>
              <div className="text-center">
                <p className={`transition-colors ${
                  isDragOver ? 'text-blue-400' : 'text-neutral-400 group-hover:text-neutral-300'
                }`}>
                  {isDragOver ? 'Drop files here' : 'Click to select files'}
                </p>
                <p className="text-sm text-neutral-600 mt-1">
                  or drag and drop (multiple files supported)
                </p>
              </div>
            </div>
          </div>
        </motion.div>
        
        {/* Send text section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-6"
        >
          <h3 className="text-sm font-medium text-neutral-500 uppercase tracking-wide mb-4">
            Send Text
          </h3>

          <form onSubmit={handleSendText} className="space-y-4">
            <textarea
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  if (textInput.trim()) {
                    onSendText(textInput.trim());
                    setTextInput('');
                  }
                }
              }}
              placeholder="Type a message to send... (⌘+Enter to send)"
              rows={4}
              className="w-full px-4 py-3 rounded-xl bg-neutral-900/60 border border-neutral-800
                text-white placeholder-neutral-600 resize-none
                focus:outline-none focus:border-neutral-700
                transition-colors duration-200"
            />

            <button
              type="submit"
              disabled={!textInput.trim()}
              className={`
                flex items-center justify-center gap-2 w-full py-3 px-4 rounded-xl
                font-medium transition-all duration-200
                ${textInput.trim()
                  ? 'bg-white text-neutral-900 hover:bg-neutral-200'
                  : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
                }
              `}
            >
              <IconSend size={18} />
              Send Text
            </button>
          </form>
        </motion.div>
      </div>

      {/* Transfer Detail Modal */}
      <AnimatePresence>
        {selectedTransfer && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
              onClick={() => setSelectedTransfer(null)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
            >
              <div
                className="w-full max-w-lg bg-neutral-900 rounded-2xl border border-neutral-800 shadow-2xl max-h-[80vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between p-4 border-b border-neutral-800">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${
                      selectedTransfer.direction === 'send'
                        ? 'bg-blue-500/20 text-blue-400'
                        : 'bg-green-500/20 text-green-400'
                    }`}>
                      {selectedTransfer.direction === 'send' ? (
                        <IconArrowUp size={18} />
                      ) : (
                        <IconArrowDown size={18} />
                      )}
                    </div>
                    <div>
                      <p className="text-white font-medium">
                        {selectedTransfer.type === 'text' ? 'Text Message' : transferFileName(selectedTransfer)}
                      </p>
                      <p className="text-xs text-neutral-500">
                        {selectedTransfer.direction === 'send' ? 'Sent' : 'Received'} • {formatTime(selectedTransfer.timestamp)}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setSelectedTransfer(null)}
                    className="p-2 rounded-lg hover:bg-neutral-800 transition-colors"
                  >
                    <IconX size={20} className="text-neutral-500" />
                  </button>
                </div>
                <div className="p-4 overflow-y-auto flex-1">
                  {selectedTransfer.type === 'text' ? (
                    <div className="space-y-3">
                      <pre className="text-white text-sm whitespace-pre-wrap break-words bg-neutral-800/50 p-4 rounded-lg">
                        {selectedTransfer.content}
                      </pre>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(selectedTransfer.content || '');
                        }}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 transition-colors"
                      >
                        <IconCopy size={16} />
                        Copy to clipboard
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="text-neutral-400 text-sm space-y-2">
                        <p><span className="text-neutral-500">File:</span> {transferFileName(selectedTransfer)}</p>
                        <p><span className="text-neutral-500">Size:</span> {(transferFileSize(selectedTransfer) / 1024).toFixed(1)} KB</p>
                        {(selectedTransfer as FileTransfer).speedBytesPerSec != null && (
                          <p>
                            <span className="text-neutral-500">Speed:</span> {formatTransferSpeed((selectedTransfer as FileTransfer).speedBytesPerSec!)}
                            {' · '}
                            <span className="text-neutral-500">Time:</span> {formatDuration((selectedTransfer as FileTransfer).durationMs!)}
                          </p>
                        )}
                        {selectedTransfer.direction === 'receive' && (selectedTransfer as any).filePath && (
                          <p><span className="text-neutral-500">Saved to:</span> <span className="text-neutral-300 break-all">{(selectedTransfer as any).filePath}</span></p>
                        )}
                      </div>
                      {selectedTransfer.direction === 'receive' && (selectedTransfer as any).filePath && (
                        <button
                          onClick={() => window.api.showInFolder((selectedTransfer as any).filePath)}
                          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 transition-colors"
                        >
                          <IconFolderOpen size={16} />
                          Show in Folder
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
