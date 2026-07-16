// Types
export * from './types';

// Crypto utilities
export * from './crypto';

// Discovery protocol
export * from './discovery';

// Pairing protocol
export * from './pairing';

// Transfer protocol
export * from './transfer';

// Message protocol
export * from './protocol';

// Ambient sharing (capture -> policy -> send). The transport itself stays in the
// app (its existing streaming + HTTP-accelerated transfer); this layer decides
// WHAT to share, to WHOM, and WHEN, and drives sending through the FileSender port.
export * from './sharing';

// Version info
export const VERSION = '1.0.0';
export const APP_NAME = 'EasyShare';
