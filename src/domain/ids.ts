import { AppError } from './errors';

/** Identifier generation. UUIDv4 strings are opaque to every consumer. */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const SHA256_HEX_LENGTH = 64;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

export function assertSha256Hex(value: unknown): string {
  if (!isSha256Hex(value)) {
    throw new AppError(
      'invalid_argument',
      'Expected a lowercase hexadecimal SHA-256 digest (64 characters).',
    );
  }
  return value;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new AppError('invalid_argument', 'Hex input must have an even number of characters.');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new AppError('invalid_argument', 'Hex input contains non-hexadecimal characters.');
    }
    out[index] = byte;
  }
  return out;
}
