// The keystore seal that backs the "remember unlock" cache: Electron safeStorage (macOS Keychain, Windows DPAPI).
// Only the three methods used are required, so tests can pass a fake and the module does not import electron.
import type { SecretBox } from './keywrap.js';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export function electronSecretBox(safeStorage: SafeStorageLike): SecretBox {
  // Linux can silently fall back to a fixed password ("basic_text"); that is not a keystore, so treat it as unavailable.
  const available = () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  return {
    available,
    seal(plain) {
      if (!available()) throw new Error('The OS keystore is not available');
      return safeStorage.encryptString(plain.toString('base64'));
    },
    open(blob) {
      if (!available()) throw new Error('The OS keystore is not available');
      return Buffer.from(safeStorage.decryptString(blob), 'base64');
    },
  };
}
