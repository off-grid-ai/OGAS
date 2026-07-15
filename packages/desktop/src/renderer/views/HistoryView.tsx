import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  IconHistory,
  IconTrash,
  IconArrowUp,
  IconArrowDown,
  IconX,
  IconCopy,
  IconFolderOpen,
} from '@tabler/icons-react';
import type { Transfer, FileTransfer } from '@easyshare/shared';
import { transferFileName, transferFileSize } from '../lib/transfer-display';
import { formatTransferSpeed, formatDuration } from '@easyshare/shared';
import { TransferItem } from '../components/TransferItem';

interface HistoryViewProps {
  transfers: Transfer[];
  onClear: () => void;
}

export function HistoryView({ transfers, onClear }: HistoryViewProps) {
  const [selectedTransfer, setSelectedTransfer] = useState<Transfer | null>(null);
  const [copied, setCopied] = useState(false);
  const isEmpty = transfers.length === 0;

  // Group transfers by date
  const groupedTransfers = transfers.reduce((groups, transfer) => {
    const date = new Date(transfer.timestamp).toDateString();
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(transfer);
    return groups;
  }, {} as Record<string, Transfer[]>);

  const formatGroupDate = (dateString: string) => {
    const date = new Date(dateString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    }
    if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    }
    return date.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const handleCopy = useCallback(() => {
    if (selectedTransfer?.type === 'text' && selectedTransfer.content) {
      navigator.clipboard.writeText(selectedTransfer.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [selectedTransfer]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-6 border-b border-neutral-800/50">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <h1 className="text-3xl font-light text-white mb-1">History</h1>
            <p className="text-neutral-500">
              {isEmpty
                ? 'No transfers yet'
                : `${transfers.length} transfer${transfers.length !== 1 ? 's' : ''}`}
            </p>
          </motion.div>

          {!isEmpty && (
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onClick={onClear}
              className="flex items-center gap-2 px-4 py-2 rounded-lg
                text-neutral-500 hover:text-white hover:bg-neutral-800
                transition-colors duration-200"
            >
              <IconTrash size={16} />
              <span className="text-sm">Clear All</span>
            </motion.button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto relative progressive-blur-bottom">
        <div className="px-6 py-6">
          <div className="max-w-3xl mx-auto">
            {isEmpty ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2 }}
                className="flex flex-col items-center justify-center py-20"
              >
                <IconHistory size={48} className="text-neutral-700 mb-4" stroke={1} />
                <p className="text-neutral-500 text-center">
                  Your transfer history will appear here
                </p>
              </motion.div>
            ) : (
              <div className="space-y-8">
                {Object.entries(groupedTransfers).map(([date, dateTransfers], groupIndex) => (
                  <motion.div
                    key={date}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: groupIndex * 0.1 }}
                  >
                    <h3 className="text-sm font-medium text-neutral-500 mb-3">
                      {formatGroupDate(date)}
                    </h3>
                    <div className="space-y-2">
                      {dateTransfers.map((transfer, index) => (
                        <TransferItem
                          key={transfer.id}
                          transfer={transfer}
                          index={index}
                          onClick={() => setSelectedTransfer(transfer)}
                        />
                      ))}
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </div>
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
                        onClick={handleCopy}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 transition-colors"
                      >
                        <IconCopy size={16} />
                        {copied ? 'Copied!' : 'Copy to clipboard'}
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
                          <p><span className="text-neutral-500">Saved to:</span> <span className="text-neutral-300">{(selectedTransfer as any).filePath}</span></p>
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
