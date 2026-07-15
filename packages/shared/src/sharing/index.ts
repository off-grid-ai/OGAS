// Ambient sharing - the "capture -> policy -> send" layer on top of transport.
// Pure logic only. Platforms supply the native CaptureWatcher and the transport;
// this module decides what to share, to whom, and when.
export * from './types';
export * from './policy';
export * from './watcher';
export * from './queue';
export * from './service';
