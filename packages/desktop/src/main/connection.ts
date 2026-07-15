import * as net from 'net';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  DeviceInfo,
  PairedDevice,
  ConnectionState,
  Message,
  Transfer,
  TransferProgress,
  TextMessage,
  FileRequestMessage,
  FileAcceptMessage,
  FileChunkMessage,
  FileCompleteMessage,
  FileAckMessage,
} from '@easyshare/shared';
import {
  MessageBuffer,
  serializeMessage,
  deserializeMessage,
  getMessageLength,
  createPingMessage,
  createPongMessage,
  createTextMessage,
  createFileRequest,
  createFileRequestStreaming,
  createFileRequestHttp,
  createFileAccept,
  createFileAcceptHttp,
  createFileAck,
  createFileChunk,
  createFileComplete,
  createFileCompleteStreaming,
  createTextTransfer,
  createFileTransfer,
  calculateProgress,
  chunkFile,
  reassembleChunks,
  verifyFileIntegrity,
  decodeBase64,
  IncrementalChecksum,
  createPairRequest,
  createPairingState,
  handlePairingMessage,
  createPairedDevice,
  getPairedDevice,
  CHUNK_SIZE,
} from '@easyshare/shared';
import type { StorageService } from './storage';

export class ConnectionManager {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private messageBuffer: MessageBuffer = new MessageBuffer();
  private connectionState: ConnectionState = { status: 'disconnected' };
  private connectedDevice: DeviceInfo | null = null;
  private currentPairingState: ReturnType<typeof createPairingState> | null = null;
  private pendingPassphrase: string | null = null;
  private localDevice: DeviceInfo | null = null;
  private storageService: StorageService;
  private localIp: string = '';
  private connectedViaEmulator: boolean = false;

  // File transfer state
  private pendingFileRequest: FileRequestMessage | null = null;
  private pendingFilePath: string | null = null;
  private pendingFileChecksum: string | null = null;
  private receivingChunks: Map<number, Uint8Array> = new Map();
  private receivingFileInfo: { fileName: string; fileSize: number; totalChunks: number; checksum: string } | null = null;
  // Streaming receive state
  private receivingHasher: IncrementalChecksum | null = null;
  private receivingTempPath: string | null = null;
  private receivingWriteStream: fs.WriteStream | null = null;
  private receivingBytesWritten: number = 0;
  private receivingStreaming: boolean = false;

  // HTTP transfer state
  private httpServer: http.Server | null = null;
  private httpSendingRequestId: string | null = null;
  private httpReceivingRequestId: string | null = null;

  // Transfer timing
  private transferStartTime: number = 0;

  // Promise resolver for sendFile - resolved when transfer completes (file_ack or chunk complete)
  private sendFileResolver: ((success: boolean) => void) | null = null;

  // Keepalive state
  private keepaliveInterval: NodeJS.Timeout | null = null;
  private lastPongReceived: number = Date.now();
  private transferActive: boolean = false;
  private readonly KEEPALIVE_INTERVAL = 5000; // Send ping every 5 seconds
  private readonly KEEPALIVE_TIMEOUT = 120000; // Disconnect if no pong for 2 minutes (generous for mobile backgrounding)

  // Callbacks
  private onConnectionStateChangeCallback?: (state: ConnectionState) => void;
  private onTransferProgressCallback?: (progress: TransferProgress) => void;
  private onTransferCompleteCallback?: (transfer: Transfer) => void;
  private onTextReceivedCallback?: (text: string, device: DeviceInfo) => void;
  private onPairingRequestCallback?: (device: DeviceInfo) => void;

  // Store pending pairing message when waiting for user passphrase
  private pendingPairingMessage: Message | null = null;

  constructor(storageService: StorageService, localIp?: string) {
    this.storageService = storageService;
    this.localIp = localIp || '';
  }

  setLocalIp(ip: string): void {
    this.localIp = ip;
  }

  /** Get the IP to use in HTTP URLs sent to the connected device */
  private getHttpIp(port: number): string {
    if (this.connectedViaEmulator) {
      // Emulator reaches host via 10.0.2.2; set up adb reverse so it works
      try {
        const { execSync } = require('child_process');
        execSync(`adb reverse tcp:${port} tcp:${port}`, { timeout: 3000 });
        console.log(`Set up adb reverse for port ${port}`);
      } catch (e) {
        console.warn('adb reverse failed:', (e as Error).message);
      }
      return '10.0.2.2';
    }
    return this.localIp || '127.0.0.1';
  }

  async start(): Promise<void> {
    const settings = this.storageService.getSettings();

    this.localDevice = {
      id: settings.deviceId,
      name: settings.deviceName,
      platform: 'macos',
      version: '1.0.0',
      host: '',
      port: 0,
    };

    // Create TCP server
    this.server = net.createServer((socket) => {
      this.handleIncomingConnection(socket);
    });

    // Listen on random available port
    await new Promise<void>((resolve) => {
      this.server!.listen(0, () => {
        const address = this.server!.address() as net.AddressInfo;
        this.localDevice!.port = address.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.shutdownHttpServer();
    this.disconnect();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  getServerInfo(): DeviceInfo {
    return this.localDevice!;
  }

  async connectToDevice(device: DeviceInfo): Promise<boolean> {
    const MAX_RETRIES = 3;
    const BASE_DELAY = 1000; // 1 second

    // If device has an Android emulator internal IP, try localhost via adb forward
    const isEmulatorIp = device.host.startsWith('10.0.2.');
    const hosts = isEmulatorIp ? ['127.0.0.1', device.host] : [device.host];

    for (const host of hosts) {
      if (isEmulatorIp) {
        console.log(`Trying host ${host} for device ${device.name} (emulator detected)`);
        // Auto-setup adb forward for emulator
        if (host === '127.0.0.1') {
          try {
            const { execSync } = require('child_process');
            execSync(`adb forward tcp:${device.port} tcp:${device.port}`, { timeout: 3000 });
            console.log(`Set up adb forward for port ${device.port}`);
          } catch (e) {
            console.warn('adb forward failed (adb may not be in PATH):', (e as Error).message);
          }
        }
      }

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        this.updateConnectionState({
          status: 'connecting',
          device,
          statusMessage: attempt === 0
            ? `Opening TCP connection to ${device.name}...`
            : `Retrying connection to ${device.name} (attempt ${attempt + 1}/${MAX_RETRIES})...`,
          pairingStep: 'connecting',
        });

        const success = await this.attemptConnection(device, host);
        if (success) return true;

        if (attempt < MAX_RETRIES - 1) {
          const delay = BASE_DELAY * (attempt + 1);
          console.log(`Connection attempt ${attempt + 1} failed (host: ${host}), retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    console.error(`All connection attempts to ${device.name} failed`);
    this.updateConnectionState({
      status: 'disconnected',
      error: `Failed to connect after all attempts`,
      statusMessage: `Connection failed after all attempts`,
      pairingStep: 'failed',
    });
    return false;
  }

  private attemptConnection(device: DeviceInfo, host?: string): Promise<boolean> {
    const connectHost = host || device.host;
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 5000); // 5 second connection timeout

      socket.on('connect', () => {
        clearTimeout(timeout);
        this.socket = socket;
        this.connectedDevice = device;
        this.connectedViaEmulator = device.host.startsWith('10.0.2.');
        this.updateConnectionState({
          status: 'connected',
          device,
          statusMessage: `Connected to ${device.name}`,
          pairingStep: 'idle',
        });
        this.setupSocketHandlers();
        resolve(true);
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        console.error('Connection attempt error:', err.message);
        socket.destroy();
        resolve(false);
      });

      socket.connect(device.port, connectHost);
    });
  }

  disconnect(): void {
    this.stopKeepalive();
    this.shutdownHttpServer();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connectedDevice = null;
    this.connectedViaEmulator = false;
    this.currentPairingState = null;
    this.pendingPassphrase = null;
    this.transferActive = false;

    // Resolve any pending sendFile promise so multi-file loops don't hang
    if (this.sendFileResolver) {
      this.sendFileResolver(false);
      this.sendFileResolver = null;
    }

    this.updateConnectionState({ status: 'disconnected' });
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.lastPongReceived = Date.now();

    this.keepaliveInterval = setInterval(() => {
      if (!this.socket) {
        this.stopKeepalive();
        return;
      }

      // Check if we've received a pong recently (skip during active transfers)
      if (!this.transferActive) {
        const timeSinceLastPong = Date.now() - this.lastPongReceived;
        if (timeSinceLastPong > this.KEEPALIVE_TIMEOUT) {
          console.log('Keepalive timeout - disconnecting');
          this.disconnect();
          return;
        }
      }

      // Send ping
      this.sendMessage(createPingMessage());
    }, this.KEEPALIVE_INTERVAL);
  }

  private stopKeepalive(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  /**
   * Reset the keepalive timer. Call after native dialogs (file picker) return
   * since the main process event loop may stall during modal dialogs,
   * causing lastPongReceived to go stale.
   */
  resetKeepaliveTimer(): void {
    this.lastPongReceived = Date.now();
  }

  async startPairing(deviceId: string, passphrase: string): Promise<boolean> {
    if (!this.socket || !this.localDevice) {
      return false;
    }

    this.pendingPassphrase = passphrase;
    this.currentPairingState = createPairingState(this.localDevice);
    this.currentPairingState.passphrase = passphrase;
    this.currentPairingState.remoteDevice = this.connectedDevice!;

    this.updateConnectionState({
      status: 'pairing',
      device: this.connectedDevice || undefined,
      statusMessage: 'Sending pairing request...',
      pairingStep: 'sending_request',
    });

    // Send pair request
    const request = createPairRequest(this.localDevice);
    this.sendMessage(request);

    this.updateConnectionState({
      status: 'pairing',
      device: this.connectedDevice || undefined,
      statusMessage: 'Waiting for challenge from remote device...',
      pairingStep: 'waiting_for_challenge',
    });

    return true;
  }

  cancelTransfer(): void {
    console.log('cancelTransfer called');
    // Shut down HTTP servers
    this.shutdownHttpServer();

    // Clean up streaming receive state
    if (this.receivingWriteStream) {
      this.receivingWriteStream.destroy();
      this.receivingWriteStream = null;
    }
    if (this.receivingTempPath) {
      try { fs.unlinkSync(this.receivingTempPath); } catch (_) {}
      this.receivingTempPath = null;
    }

    // Clean up all transfer state
    this.receivingHasher = null;
    this.receivingBytesWritten = 0;
    this.receivingStreaming = false;
    this.receivingChunks.clear();
    this.receivingFileInfo = null;
    this.pendingFileRequest = null;
    this.pendingFilePath = null;
    this.pendingFileChecksum = null;
    this.httpSendingRequestId = null;
    this.httpReceivingRequestId = null;
    this.transferActive = false;
    this.lastPongReceived = Date.now();

    // Clear progress
    if (this.onTransferProgressCallback) {
      this.onTransferProgressCallback(null as any);
    }

    // Resolve pending sendFile promise so multi-file loops stop
    if (this.sendFileResolver) {
      this.sendFileResolver(false);
      this.sendFileResolver = null;
    }
  }

  async sendText(text: string): Promise<boolean> {
    console.log('sendText called, socket:', !!this.socket, 'device:', !!this.connectedDevice);
    if (!this.socket || !this.connectedDevice) {
      console.log('sendText: No socket or device');
      return false;
    }

    const message = createTextMessage(text);
    this.sendMessage(message);
    console.log('sendText: Message sent');

    // Create transfer record
    const transfer = createTextTransfer(text, this.connectedDevice, 'send');
    console.log('sendText: Transfer created', transfer.id);
    if (this.onTransferCompleteCallback) {
      console.log('sendText: Calling onTransferComplete callback');
      this.onTransferCompleteCallback(transfer);
    } else {
      console.log('sendText: No onTransferComplete callback!');
    }

    return true;
  }

  async sendFile(filePath: string): Promise<boolean> {
    if (!this.socket || !this.connectedDevice) {
      return false;
    }

    try {
      const fileName = path.basename(filePath);
      const stats = await fs.promises.stat(filePath);
      const mimeType = 'application/octet-stream';

      this.transferStartTime = Date.now();

      // Create a promise that resolves when the full transfer completes.
      // This allows callers to await sendFile() for sequential multi-file transfers.
      const transferComplete = new Promise<boolean>((resolve) => {
        this.sendFileResolver = resolve;
      });

      if (stats.size < 5 * 1024 * 1024) {
        // Small file: load into memory (existing chunk approach)
        const fileData = await fs.promises.readFile(filePath);
        const request = createFileRequest(fileName, stats.size, mimeType, fileData);
        this.sendMessage(request);
        this.pendingFileRequest = request;
        this.pendingFilePath = filePath;
        this.pendingFileChecksum = null;
      } else {
        // Large file: use HTTP transfer
        // Skip expensive checksum computation - mobile verifies by file size,
        // and TCP ensures data integrity at the transport layer.
        const checksum = `size:${stats.size}`;
        const { url } = await this.startHttpFileServer(filePath, stats.size);
        const request = createFileRequestHttp(fileName, stats.size, mimeType, checksum, url);
        this.sendMessage(request);
        this.pendingFileRequest = request;
        this.pendingFilePath = filePath;
        this.pendingFileChecksum = checksum;
        this.httpSendingRequestId = request.id;
      }

      // Wait for the transfer to actually complete before returning
      return await transferComplete;
    } catch (err) {
      console.error('Failed to send file:', err);
      this.sendFileResolver = null;
      return false;
    }
  }

  private computeStreamingChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hasher = new IncrementalChecksum();
      const stream = fs.createReadStream(filePath, { highWaterMark: 512 * 1024 });

      stream.on('data', (chunk) => {
        hasher.update(new Uint8Array(chunk as Buffer));
      });

      stream.on('end', () => {
        resolve(hasher.digest());
      });

      stream.on('error', reject);
    });
  }

  // Callbacks
  onConnectionStateChange(callback: (state: ConnectionState) => void): void {
    this.onConnectionStateChangeCallback = callback;
  }

  onTransferProgress(callback: (progress: TransferProgress) => void): void {
    this.onTransferProgressCallback = callback;
  }

  onTransferComplete(callback: (transfer: Transfer) => void): void {
    this.onTransferCompleteCallback = callback;
  }

  onTextReceived(callback: (text: string, device: DeviceInfo) => void): void {
    this.onTextReceivedCallback = callback;
  }

  onPairingRequest(callback: (device: DeviceInfo) => void): void {
    this.onPairingRequestCallback = callback;
  }

  respondToPairing(passphrase: string): void {
    this.pendingPassphrase = passphrase;

    // Process the pending pairing message now that we have the passphrase
    if (this.pendingPairingMessage) {
      const message = this.pendingPairingMessage;
      this.pendingPairingMessage = null;
      this.handlePairingMessage(message);
    }
  }

  // Private methods
  private handleIncomingConnection(socket: net.Socket): void {
    if (this.socket) {
      const socketDead = this.socket.destroyed || !this.socket.writable;
      // Also consider the socket stale if no data received for >30s
      const stale = (Date.now() - this.lastPongReceived) > 30000;

      if (socketDead || stale) {
        // Old socket is dead or stale - clean up and accept the new one
        console.log('Replacing dead/stale socket with new incoming connection');
        this.stopKeepalive();
        this.shutdownHttpServer();
        try { this.socket.destroy(); } catch (_) { /* ignore */ }
        this.socket = null;
        this.transferActive = false;
      } else {
        // Existing socket is alive - reject the new one
        socket.destroy();
        return;
      }
    }

    this.socket = socket;
    this.updateConnectionState({ status: 'connecting' });
    this.setupSocketHandlers();
  }

  private setupSocketHandlers(): void {
    if (!this.socket) return;

    // Enable TCP keepalive at the socket level
    this.socket.setKeepAlive(true, 10000);
    this.socket.setNoDelay(true);

    this.socket.on('data', (data) => {
      this.messageBuffer.append(new Uint8Array(data));
      this.processMessages();
    });

    this.socket.on('close', () => {
      this.disconnect();
    });

    this.socket.on('error', (err) => {
      console.error('Socket error:', err);
      this.disconnect();
    });

    // Start application-level keepalive
    this.startKeepalive();
  }

  private processMessages(): void {
    const messages = this.messageBuffer.extractAllMessages();
    for (const message of messages) {
      this.handleMessage(message);
    }
  }

  private handleMessage(message: Message): void {
    // Any incoming message proves the connection is alive - reset keepalive timer.
    this.lastPongReceived = Date.now();

    switch (message.type) {
      case 'ping':
        this.sendMessage(createPongMessage(message.id));
        break;

      case 'pong':
        break;

      case 'pair_request':
      case 'pair_challenge':
      case 'pair_response':
      case 'pair_confirm':
      case 'pair_reject':
        this.handlePairingMessage(message);
        break;

      case 'text':
        this.handleTextMessage(message as TextMessage);
        break;

      case 'file_request':
        this.handleFileRequest(message as FileRequestMessage);
        break;

      case 'file_accept':
        this.handleFileAccept(message as FileAcceptMessage);
        break;

      case 'file_chunk':
        this.handleFileChunk(message as FileChunkMessage);
        break;

      case 'file_complete':
        this.handleFileComplete(message as FileCompleteMessage);
        break;

      case 'file_ack':
        this.handleFileAck(message as FileAckMessage);
        break;
    }
  }

  private handlePairingMessage(message: Message): void {
    if (!this.currentPairingState || !this.localDevice) {
      // Create new pairing state for incoming request
      this.currentPairingState = createPairingState(this.localDevice!);
    }

    // If this is an incoming pair_request and we don't have a passphrase yet,
    // store the message and notify the UI to get the passphrase from user
    if (message.type === 'pair_request' && !this.pendingPassphrase) {
      console.log('Received pair_request, waiting for user passphrase');
      this.pendingPairingMessage = message;

      // Extract remote device info from the message and notify UI
      const remoteDevice = (message as any).payload?.deviceInfo as DeviceInfo | undefined;
      if (remoteDevice) {
        this.connectedDevice = remoteDevice;
        this.updateConnectionState({
          status: 'pairing',
          device: remoteDevice,
          statusMessage: `Pairing request from ${remoteDevice.name}. Enter passphrase to continue.`,
          pairingStep: 'waiting_for_passphrase',
        });
        if (this.onPairingRequestCallback) {
          this.onPairingRequestCallback(remoteDevice);
        }
      }
      return;
    }

    // Log and update status based on message type
    console.log(`Processing pairing message: ${message.type}`);

    if (message.type === 'pair_request') {
      this.updateConnectionState({
        status: 'pairing',
        device: this.connectedDevice || undefined,
        statusMessage: 'Deriving encryption key from passphrase...',
        pairingStep: 'deriving_key',
      });
    } else if (message.type === 'pair_challenge') {
      this.updateConnectionState({
        status: 'pairing',
        device: this.connectedDevice || undefined,
        statusMessage: 'Received challenge. Computing response...',
        pairingStep: 'responding_to_challenge',
      });
    } else if (message.type === 'pair_response') {
      this.updateConnectionState({
        status: 'pairing',
        device: this.connectedDevice || undefined,
        statusMessage: 'Verifying passphrase match...',
        pairingStep: 'verifying_response',
      });
    }

    const { newState, response } = handlePairingMessage(
      this.currentPairingState,
      message,
      this.pendingPassphrase || undefined
    );

    this.currentPairingState = newState;

    if (response) {
      if (response.type === 'pair_challenge') {
        this.updateConnectionState({
          status: 'pairing',
          device: this.connectedDevice || undefined,
          statusMessage: 'Sending cryptographic challenge...',
          pairingStep: 'sending_challenge',
        });
      } else if (response.type === 'pair_response') {
        this.updateConnectionState({
          status: 'pairing',
          device: this.connectedDevice || undefined,
          statusMessage: 'Sending challenge response...',
          pairingStep: 'responding_to_challenge',
        });
      } else if (response.type === 'pair_confirm') {
        this.updateConnectionState({
          status: 'pairing',
          device: this.connectedDevice || undefined,
          statusMessage: 'Passphrase verified! Confirming pairing...',
          pairingStep: 'confirming',
        });
      }
      this.sendMessage(response);
    }

    if (newState.status === 'success') {
      // Pairing successful - save paired device
      const pairedDevice = createPairedDevice(newState);
      if (pairedDevice) {
        this.storageService.addPairedDevice(pairedDevice);
        this.connectedDevice = newState.remoteDevice!;
        this.updateConnectionState({
          status: 'connected',
          device: this.connectedDevice || undefined,
          statusMessage: 'Pairing successful! Devices are now paired.',
          pairingStep: 'success',
        });
      }
    } else if (newState.status === 'failed') {
      this.updateConnectionState({
        status: 'disconnected',
        error: newState.error,
        statusMessage: `Pairing failed: ${newState.error}`,
        pairingStep: 'failed',
      });
    } else if (newState.status === 'waiting') {
      // Need passphrase from user - update UI
      this.connectedDevice = newState.remoteDevice!;
      this.updateConnectionState({
        status: 'pairing',
        device: this.connectedDevice || undefined,
        statusMessage: 'Waiting for passphrase...',
        pairingStep: 'waiting_for_passphrase',
      });
    }
  }

  private handleTextMessage(message: TextMessage): void {
    if (!this.connectedDevice) return;

    const text = message.payload.content;

    // Create transfer record
    const transfer = createTextTransfer(text, this.connectedDevice, 'receive');
    if (this.onTransferCompleteCallback) {
      this.onTransferCompleteCallback(transfer);
    }

    if (this.onTextReceivedCallback) {
      this.onTextReceivedCallback(text, this.connectedDevice);
    }
  }

  private async handleFileRequest(message: FileRequestMessage): Promise<void> {
    if (!this.connectedDevice) return;

    this.transferActive = true; // Pause keepalive timeout during transfer
    this.transferStartTime = Date.now();
    const fileSize = message.payload.fileSize;
    const isLargeFile = fileSize > 5 * 1024 * 1024;

    this.receivingFileInfo = {
      fileName: message.payload.fileName,
      fileSize,
      totalChunks: Math.ceil(fileSize / (64 * 1024)),
      checksum: message.payload.checksum,
    };

    const settings = this.storageService.getSettings();

    // If sender included httpUrl, this is an HTTP download (desktop receives metadata only, mobile won't send chunks).
    // We just accept and wait - mobile will download from httpUrl and send file_ack.
    // (This case shouldn't happen when desktop is the receiver from mobile,
    //  but handle it for completeness if both sides are desktops someday.)
    if (message.payload.httpUrl) {
      this.sendMessage(createFileAccept(message.id));
      return;
    }

    if (isLargeFile) {
      // Large file from mobile → desktop: start HTTP upload server
      const savePath = path.join(settings.saveDirectory, message.payload.fileName);
      try {
        this.httpReceivingRequestId = message.id;
        const { url } = await this.startHttpUploadServer(savePath, fileSize, message.payload.checksum);
        this.sendMessage(createFileAcceptHttp(message.id, url));
        console.log('Started HTTP upload server for mobile→desktop transfer');
        return;
      } catch (err) {
        console.error('Failed to start HTTP upload server, falling back to chunks:', err);
        this.httpReceivingRequestId = null;
        // Fall through to chunk-based receive
      }

      // Fallback: chunk-based streaming receive
      this.receivingStreaming = true;
      this.receivingHasher = new IncrementalChecksum();
      this.receivingTempPath = path.join(settings.saveDirectory, `.easyshare_tmp_${Date.now()}`);
      this.receivingWriteStream = fs.createWriteStream(this.receivingTempPath);
      this.receivingBytesWritten = 0;
      console.log('Using streaming receive for large file (fallback)');
    } else {
      // Small file: collect chunks in memory
      this.receivingStreaming = false;
      this.receivingChunks.clear();
    }

    this.sendMessage(createFileAccept(message.id));
  }

  private async handleFileAccept(message?: FileAcceptMessage): Promise<void> {
    if (!this.pendingFileRequest || !this.connectedDevice || !this.pendingFilePath) return;

    this.transferActive = true; // Pause keepalive timeout during send
    const requestId = this.pendingFileRequest.id;
    const fileName = this.pendingFileRequest.payload.fileName;
    const mimeType = this.pendingFileRequest.payload.mimeType;

    // If this is an HTTP send (desktop→mobile), the HTTP server is already running.
    // Just wait for file_ack from mobile - no chunks to send.
    if (this.httpSendingRequestId) {
      console.log('HTTP send: waiting for mobile to download and send file_ack...');
      // Transfer completion will be handled by handleFileAck()
      return;
    }

    try {
      const stats = await fs.promises.stat(this.pendingFilePath);
      const totalBytes = stats.size;

      if (this.pendingFileChecksum) {
        // Large file without HTTP (fallback): stream from disk using pre-computed checksum
        await this.streamFileChunks(this.pendingFilePath, requestId, totalBytes, fileName);

        const completeMessage = createFileCompleteStreaming(requestId, this.pendingFileChecksum);
        this.sendMessage(completeMessage);
      } else {
        // Small file: read into memory (existing approach)
        const fileData = await fs.promises.readFile(this.pendingFilePath);

        let bytesTransferred = 0;
        for (const { chunk, index, total } of chunkFile(fileData)) {
          const chunkMessage = createFileChunk(requestId, index, total, chunk);
          this.sendMessage(chunkMessage);

          bytesTransferred += chunk.length;
          if (this.onTransferProgressCallback) {
            this.onTransferProgressCallback(
              calculateProgress(requestId, bytesTransferred, totalBytes, undefined, this.transferStartTime)
            );
          }
        }

        const completeMessage = createFileComplete(requestId, fileData);
        this.sendMessage(completeMessage);
      }

      // Create transfer record
      const durationMs = Date.now() - this.transferStartTime;
      const transfer = createFileTransfer(fileName, totalBytes, mimeType, this.connectedDevice, 'send', durationMs);
      if (this.onTransferCompleteCallback) {
        this.onTransferCompleteCallback(transfer);
      }

      // Clear progress
      if (this.onTransferProgressCallback) {
        this.onTransferProgressCallback(null as any);
      }

      this.pendingFileRequest = null;
      this.pendingFilePath = null;
      this.pendingFileChecksum = null;
      // Keep transferActive for a grace period - the receiver needs time to
      // process and write all chunks to disk before it can respond to pings
      this.lastPongReceived = Date.now();
      setTimeout(() => {
        this.transferActive = false;
        this.lastPongReceived = Date.now();
      }, 120000); // 2 minute grace period for receiver to finish processing

      // Resolve sendFile promise
      if (this.sendFileResolver) {
        this.sendFileResolver(true);
        this.sendFileResolver = null;
      }
    } catch (err) {
      console.error('Failed to send file:', err);
      this.pendingFileRequest = null;
      this.pendingFilePath = null;
      this.pendingFileChecksum = null;
      this.transferActive = false;
      this.lastPongReceived = Date.now();

      // Resolve sendFile promise with failure
      if (this.sendFileResolver) {
        this.sendFileResolver(false);
        this.sendFileResolver = null;
      }
    }
  }

  private async streamFileChunks(filePath: string, requestId: string, totalBytes: number, fileName: string): Promise<void> {
    // Read file in larger blocks (512KB) and split into protocol chunks (64KB)
    // This is more efficient and allows us to pace sending
    const BLOCK_SIZE = 512 * 1024;
    const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);
    let chunkIndex = 0;
    let bytesTransferred = 0;

    const fileHandle = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(BLOCK_SIZE);
      let bytesRead: number;

      do {
        const result = await fileHandle.read(buffer, 0, BLOCK_SIZE, bytesTransferred);
        bytesRead = result.bytesRead;
        if (bytesRead === 0) break;

        // Split block into 64KB protocol chunks
        let offset = 0;
        while (offset < bytesRead) {
          const end = Math.min(offset + CHUNK_SIZE, bytesRead);
          const chunk = new Uint8Array(buffer.slice(offset, end));
          const chunkMessage = createFileChunk(requestId, chunkIndex, totalChunks, chunk);

          // Write with backpressure handling
          const canContinue = this.socket?.write(Buffer.from(serializeMessage(chunkMessage)));
          if (canContinue === false) {
            await new Promise<void>((resolve) => {
              this.socket?.once('drain', resolve);
            });
          }

          chunkIndex++;
          offset = end;
        }

        bytesTransferred += bytesRead;

        if (this.onTransferProgressCallback) {
          this.onTransferProgressCallback(
            calculateProgress(requestId, bytesTransferred, totalBytes, fileName, this.transferStartTime)
          );
        }

        // Pace sending: small delay every block to let receiver process
        await new Promise((r) => setTimeout(r, 10));
      } while (bytesRead === BLOCK_SIZE);
    } finally {
      await fileHandle.close();
    }
  }

  private handleFileChunk(message: FileChunkMessage): void {
    const chunkData = decodeBase64(message.payload.data);

    if (this.receivingStreaming) {
      // Streaming mode: hash chunk + write to disk immediately
      this.receivingHasher?.update(chunkData);
      this.receivingWriteStream?.write(Buffer.from(chunkData));
      this.receivingBytesWritten += chunkData.length;

      if (this.onTransferProgressCallback && this.receivingFileInfo) {
        this.onTransferProgressCallback(
          calculateProgress(
            message.payload.requestId,
            this.receivingBytesWritten,
            this.receivingFileInfo.fileSize,
            this.receivingFileInfo.fileName,
            this.transferStartTime
          )
        );
      }
    } else {
      // In-memory mode for small files
      this.receivingChunks.set(message.payload.chunkIndex, chunkData);

      if (this.onTransferProgressCallback && this.receivingFileInfo) {
        this.onTransferProgressCallback(
          calculateProgress(
            message.payload.requestId,
            this.receivingChunks.size * CHUNK_SIZE,
            this.receivingFileInfo.fileSize,
            this.receivingFileInfo.fileName,
            this.transferStartTime
          )
        );
      }
    }
  }

  private async handleFileComplete(message: FileCompleteMessage): Promise<void> {
    if (!this.receivingFileInfo || !this.connectedDevice) return;

    const settings = this.storageService.getSettings();
    const savePath = path.join(settings.saveDirectory, this.receivingFileInfo.fileName);

    if (this.receivingStreaming) {
      // Close write stream
      await new Promise<void>((resolve) => {
        if (this.receivingWriteStream) {
          this.receivingWriteStream.end(() => resolve());
        } else {
          resolve();
        }
      });
      this.receivingWriteStream = null;

      // Verify streaming checksum
      const computedChecksum = this.receivingHasher?.digest();
      const expectedChecksum = message.payload.checksum;

      if (computedChecksum !== expectedChecksum) {
        console.error('File integrity check failed (streaming):', computedChecksum, '!==', expectedChecksum);
        // Clean up temp file
        if (this.receivingTempPath) {
          try { await fs.promises.unlink(this.receivingTempPath); } catch (_) {}
        }
        this.cleanupStreamingReceiveState();
        return;
      }

      // Move temp file to final destination
      try {
        if (this.receivingTempPath) {
          await fs.promises.rename(this.receivingTempPath, savePath);
        }
        console.log('File saved (streaming):', savePath);

        const durationMs = Date.now() - this.transferStartTime;
        const transfer = createFileTransfer(
          this.receivingFileInfo.fileName,
          this.receivingBytesWritten,
          'application/octet-stream',
          this.connectedDevice,
          'receive',
          durationMs
        );
        (transfer as any).filePath = savePath;

        if (this.onTransferCompleteCallback) {
          this.onTransferCompleteCallback(transfer);
        }
      } catch (err) {
        console.error('Failed to save file (streaming):', err);
        if (this.receivingTempPath) {
          try { await fs.promises.unlink(this.receivingTempPath); } catch (_) {}
        }
      }

      this.cleanupStreamingReceiveState();
    } else {
      // In-memory mode for small files
      const totalChunks = this.receivingFileInfo.totalChunks;
      const fileData = reassembleChunks(this.receivingChunks, totalChunks);

      if (!fileData) {
        console.error('Failed to reassemble file - missing chunks');
        this.receivingChunks.clear();
        this.receivingFileInfo = null;
        return;
      }

      if (!verifyFileIntegrity(fileData, message.payload.checksum)) {
        console.error('File integrity check failed');
        this.receivingChunks.clear();
        this.receivingFileInfo = null;
        return;
      }

      try {
        await fs.promises.writeFile(savePath, Buffer.from(fileData));

        const durationMs = Date.now() - this.transferStartTime;
        const transfer = createFileTransfer(
          this.receivingFileInfo.fileName,
          fileData.length,
          'application/octet-stream',
          this.connectedDevice,
          'receive',
          durationMs
        );
        (transfer as any).filePath = savePath;

        if (this.onTransferCompleteCallback) {
          this.onTransferCompleteCallback(transfer);
        }
      } catch (err) {
        console.error('Failed to save file:', err);
      }

      this.receivingChunks.clear();
    }

    this.receivingFileInfo = null;
    this.transferActive = false;
    this.lastPongReceived = Date.now();
  }

  private handleFileAck(message: FileAckMessage): void {
    const requestId = message.payload.requestId;
    console.log('Received file_ack for', requestId, 'success:', message.payload.success);

    // This is the ack for an HTTP send (desktop→mobile)
    if (this.httpSendingRequestId === requestId && this.pendingFileRequest && this.connectedDevice) {
      this.shutdownHttpServer();
      const fileName = this.pendingFileRequest.payload.fileName;
      const fileSize = this.pendingFileRequest.payload.fileSize;
      const mimeType = this.pendingFileRequest.payload.mimeType;

      if (message.payload.success) {
        const durationMs = Date.now() - this.transferStartTime;
        const transfer = createFileTransfer(fileName, fileSize, mimeType, this.connectedDevice, 'send', durationMs);
        if (this.onTransferCompleteCallback) {
          this.onTransferCompleteCallback(transfer);
        }
      }

      if (this.onTransferProgressCallback) {
        this.onTransferProgressCallback(null as any);
      }

      this.pendingFileRequest = null;
      this.pendingFilePath = null;
      this.pendingFileChecksum = null;
      this.httpSendingRequestId = null;
      this.transferActive = false;
      this.lastPongReceived = Date.now();

      // Resolve sendFile promise
      if (this.sendFileResolver) {
        this.sendFileResolver(message.payload.success);
        this.sendFileResolver = null;
      }
    }
  }

  private cleanupStreamingReceiveState(): void {
    this.receivingHasher = null;
    this.receivingTempPath = null;
    this.receivingWriteStream = null;
    this.receivingBytesWritten = 0;
    this.receivingStreaming = false;
    this.receivingFileInfo = null;
    this.transferActive = false;
    this.lastPongReceived = Date.now();
  }

  private startHttpFileServer(filePath: string, fileSize: number): Promise<{ url: string }> {
    return new Promise((resolve, reject) => {
      const token = crypto.randomUUID();
      const urlPath = `/transfer/${token}`;

      const server = http.createServer((req, res) => {
        if (req.url !== urlPath || req.method !== 'GET') {
          res.writeHead(404);
          res.end();
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileSize,
          'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
        });

        const readStream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
        let bytesSent = 0;
        let lastProgressTime = 0;

        readStream.on('data', (chunk: string | Buffer) => {
          bytesSent += chunk.length;
          const now = Date.now();
          if (now - lastProgressTime >= 100 && this.onTransferProgressCallback && this.httpSendingRequestId) {
            lastProgressTime = now;
            this.onTransferProgressCallback(
              calculateProgress(this.httpSendingRequestId, bytesSent, fileSize, path.basename(filePath), this.transferStartTime)
            );
          }
          if (!res.write(chunk)) {
            readStream.pause();
            res.once('drain', () => readStream.resume());
          }
        });
        readStream.on('end', () => res.end());
        readStream.on('error', (err) => {
          console.error('HTTP file serve error:', err);
          res.destroy();
        });
      });

      server.listen(0, '0.0.0.0', () => {
        const addr = server.address() as net.AddressInfo;
        this.httpServer = server;
        const ip = this.getHttpIp(addr.port);
        const url = `http://${ip}:${addr.port}${urlPath}`;
        console.log('HTTP file server started:', url);
        resolve({ url });
      });

      server.on('error', reject);
    });
  }

  private startHttpUploadServer(savePath: string, expectedSize: number, expectedChecksum: string): Promise<{ url: string }> {
    return new Promise((resolve, reject) => {
      const token = crypto.randomUUID();
      const urlPath = `/upload/${token}`;
      const tempPath = savePath + '.tmp';

      const server = http.createServer((req, res) => {
        if (req.url !== urlPath || req.method !== 'POST') {
          res.writeHead(404);
          res.end();
          return;
        }

        // RNFS.uploadFiles sends multipart/form-data.
        // We need to extract the file content from the multipart body.
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)/);

        if (!boundaryMatch) {
          // If no boundary, treat as raw binary upload
          this.handleRawUpload(req, res, tempPath, savePath, expectedSize, expectedChecksum);
          return;
        }

        // Multipart upload from RNFS.uploadFiles
        this.handleMultipartUpload(req, res, tempPath, savePath, expectedSize, expectedChecksum, boundaryMatch[1]);
      });

      server.listen(0, '0.0.0.0', () => {
        const addr = server.address() as net.AddressInfo;
        this.httpServer = server;
        const ip = this.getHttpIp(addr.port);
        const url = `http://${ip}:${addr.port}${urlPath}`;
        console.log('HTTP upload server started:', url);
        resolve({ url });
      });

      server.on('error', reject);
    });
  }

  private handleRawUpload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    tempPath: string,
    savePath: string,
    expectedSize: number,
    expectedChecksum: string
  ): void {
    const writeStream = fs.createWriteStream(tempPath, { highWaterMark: 4 * 1024 * 1024 });
    const sizeBasedVerification = expectedChecksum.startsWith('size:');
    const hasher = sizeBasedVerification ? null : new IncrementalChecksum();
    let bytesReceived = 0;
    let lastProgressTime = 0;

    req.on('data', (chunk: Buffer) => {
      hasher?.update(new Uint8Array(chunk));
      if (!writeStream.write(chunk)) req.pause();
      bytesReceived += chunk.length;

      const now = Date.now();
      if (now - lastProgressTime >= 100 && this.onTransferProgressCallback && this.httpReceivingRequestId) {
        lastProgressTime = now;
        this.onTransferProgressCallback(
          calculateProgress(this.httpReceivingRequestId, bytesReceived, expectedSize, undefined, this.transferStartTime)
        );
      }
    });

    writeStream.on('drain', () => req.resume());

    req.on('end', () => {
      writeStream.end(() => {
        this.finalizeUpload(res, tempPath, savePath, bytesReceived, hasher, expectedChecksum);
      });
    });

    req.on('error', (err) => {
      console.error('HTTP upload request error:', err);
      writeStream.destroy();
      try { fs.unlinkSync(tempPath); } catch (_) {}
      res.writeHead(500);
      res.end('upload error');
    });
  }

  private handleMultipartUpload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    tempPath: string,
    savePath: string,
    expectedSize: number,
    expectedChecksum: string,
    boundary: string
  ): void {
    const writeStream = fs.createWriteStream(tempPath, { highWaterMark: 4 * 1024 * 1024 });
    // Skip expensive SHA-512 hashing when using size-based verification
    const sizeBasedVerification = expectedChecksum.startsWith('size:');
    const hasher = sizeBasedVerification ? null : new IncrementalChecksum();
    let headersParsed = false;
    let headerBuffer = Buffer.alloc(0);
    let bytesWritten = 0;
    let lastProgressTime = 0;
    const headerEndMarker = Buffer.from('\r\n\r\n');

    req.on('data', (chunk: Buffer) => {
      if (!headersParsed) {
        // Still looking for end of multipart headers
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const headerEndIdx = headerBuffer.indexOf(headerEndMarker);
        if (headerEndIdx !== -1) {
          headersParsed = true;
          const fileContentStart = headerEndIdx + 4;
          const remaining = headerBuffer.slice(fileContentStart);
          headerBuffer = Buffer.alloc(0);
          if (remaining.length > 0 && bytesWritten < expectedSize) {
            const toWrite = remaining.slice(0, Math.min(remaining.length, expectedSize - bytesWritten));
            hasher?.update(new Uint8Array(toWrite));
            if (!writeStream.write(toWrite)) req.pause();
            bytesWritten += toWrite.length;
          }
        }
      } else {
        const rem = expectedSize - bytesWritten;
        if (rem > 0) {
          const toWrite = chunk.slice(0, Math.min(chunk.length, rem));
          hasher?.update(new Uint8Array(toWrite));
          if (!writeStream.write(toWrite)) req.pause();
          bytesWritten += toWrite.length;
        }
      }

      const now = Date.now();
      if (now - lastProgressTime >= 100 && this.onTransferProgressCallback && this.httpReceivingRequestId) {
        lastProgressTime = now;
        this.onTransferProgressCallback(
          calculateProgress(this.httpReceivingRequestId, Math.min(bytesWritten, expectedSize), expectedSize, undefined, this.transferStartTime)
        );
      }
    });

    writeStream.on('drain', () => req.resume());

    req.on('end', () => {
      writeStream.end(() => {
        this.finalizeUpload(res, tempPath, savePath, bytesWritten, hasher, expectedChecksum);
      });
    });

    req.on('error', (err) => {
      console.error('HTTP multipart upload error:', err);
      writeStream.destroy();
      try { fs.unlinkSync(tempPath); } catch (_) {}
      res.writeHead(500);
      res.end('upload error');
    });
  }

  private async finalizeUpload(
    res: http.ServerResponse,
    tempPath: string,
    savePath: string,
    bytesReceived: number,
    hasher: IncrementalChecksum | null,
    expectedChecksum: string
  ): Promise<void> {
    try {
      // Verify upload integrity. If the sender used size-based verification (HTTP path),
      // check file size. Otherwise fall back to checksum verification.
      if (expectedChecksum.startsWith('size:')) {
        const expectedSize = parseInt(expectedChecksum.substring(5), 10);
        if (bytesReceived !== expectedSize) {
          console.error('HTTP upload size mismatch:', bytesReceived, '!==', expectedSize);
          try { await fs.promises.unlink(tempPath); } catch (_) {}
          res.writeHead(400);
          res.end('size mismatch');

          if (this.httpReceivingRequestId) {
            this.sendMessage(createFileAck(this.httpReceivingRequestId, false));
          }
          this.httpReceivingRequestId = null;
          this.receivingFileInfo = null;
          this.transferActive = false;
          this.lastPongReceived = Date.now();
          this.shutdownHttpServer();
          return;
        }
        console.log('HTTP upload size verified:', bytesReceived, 'bytes');
      } else if (hasher) {
        const computedChecksum = hasher.digest();
        if (computedChecksum !== expectedChecksum) {
          console.error('HTTP upload checksum mismatch:', computedChecksum, '!==', expectedChecksum);
          try { await fs.promises.unlink(tempPath); } catch (_) {}
          res.writeHead(400);
          res.end('checksum mismatch');

          if (this.httpReceivingRequestId) {
            this.sendMessage(createFileAck(this.httpReceivingRequestId, false));
          }
          this.httpReceivingRequestId = null;
          this.receivingFileInfo = null;
          this.transferActive = false;
          this.lastPongReceived = Date.now();
          this.shutdownHttpServer();
          return;
        }
      }

      // Move temp to final
      try { await fs.promises.unlink(savePath); } catch (_) {}
      await fs.promises.rename(tempPath, savePath);
      console.log('HTTP upload saved:', savePath);

      res.writeHead(200);
      res.end('ok');

      // Send ack and complete transfer
      if (this.httpReceivingRequestId && this.connectedDevice && this.receivingFileInfo) {
        const durationMs = Date.now() - this.transferStartTime;
        const transfer = createFileTransfer(
          this.receivingFileInfo.fileName,
          bytesReceived,
          'application/octet-stream',
          this.connectedDevice,
          'receive',
          durationMs
        );
        (transfer as any).filePath = savePath;
        if (this.onTransferCompleteCallback) {
          this.onTransferCompleteCallback(transfer);
        }
        if (this.onTransferProgressCallback) {
          this.onTransferProgressCallback(null as any);
        }
        this.sendMessage(createFileAck(this.httpReceivingRequestId, true));
        this.httpReceivingRequestId = null;
        this.receivingFileInfo = null;
        this.transferActive = false;
        this.lastPongReceived = Date.now();
        this.shutdownHttpServer();
      }
    } catch (err) {
      console.error('HTTP upload post-processing error:', err);
      try { await fs.promises.unlink(tempPath); } catch (_) {}
      res.writeHead(500);
      res.end('server error');
    }
  }

  private shutdownHttpServer(): void {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }

  private sendMessage(message: Message): void {
    if (!this.socket) return;

    const buffer = serializeMessage(message);
    this.socket.write(Buffer.from(buffer));
  }

  private updateConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    if (this.onConnectionStateChangeCallback) {
      this.onConnectionStateChangeCallback(state);
    }
  }
}
