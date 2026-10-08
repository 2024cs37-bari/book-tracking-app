import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HASH_CHUNK_BYTES,
  Sha256,
  sha256Blob,
  sha256Hex,
  sha256Text,
  verifySha256,
} from '~/storage/sha256';

const KNOWN_VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  [
    'The quick brown fox jumps over the lazy dog',
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
  ],
];

function reference(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  // getRandomValues rejects requests larger than 65536 bytes per call.
  const maxPerCall = 65_536;
  for (let offset = 0; offset < length; offset += maxPerCall) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + maxPerCall, length)));
  }
  return bytes;
}

describe('Sha256', () => {
  it.each(KNOWN_VECTORS)('hashes the known vector for %j', (input, expected) => {
    expect(sha256Text(input)).toBe(expected);
  });

  it('hashes one million "a" bytes (multi-block padding boundary)', () => {
    const bytes = new Uint8Array(1_000_000).fill(0x61);
    expect(sha256Hex(bytes)).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it.each([0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096])(
    'matches an independent implementation for %i random bytes',
    (length) => {
      const bytes = randomBytes(length);
      expect(sha256Hex(bytes)).toBe(reference(bytes));
    },
  );

  it('matches an independent implementation when updated in arbitrary slices', () => {
    const bytes = randomBytes(20_000);
    const hasher = new Sha256();
    let offset = 0;
    const stepPattern = [1, 7, 63, 64, 65, 100, 511, 1024, 3333];
    let stepIndex = 0;
    while (offset < bytes.length) {
      const step = stepPattern[stepIndex % stepPattern.length]!;
      hasher.update(bytes.subarray(offset, offset + step));
      offset += step;
      stepIndex += 1;
    }
    expect(hasher.hexDigest()).toBe(reference(bytes));
  });

  it('rejects updates after finalization', () => {
    const hasher = new Sha256();
    hasher.update(new Uint8Array([1, 2, 3]));
    hasher.digest();
    expect(() => hasher.update(new Uint8Array([4]))).toThrow(/finalized/i);
    expect(() => hasher.digest()).toThrow(/finalized/i);
  });

  it('produces the same digest regardless of chunk size when hashing a Blob', async () => {
    const bytes = randomBytes(5000);
    const blob = new Blob([bytes]);
    const expected = reference(bytes);
    for (const chunkBytes of [1, 7, 64, 1024, 5000, 8192, DEFAULT_HASH_CHUNK_BYTES]) {
      await expect(sha256Blob(blob, chunkBytes)).resolves.toBe(expected);
    }
  });

  it('streams a Blob larger than one chunk', async () => {
    const bytes = randomBytes(3 * DEFAULT_HASH_CHUNK_BYTES + 17);
    const blob = new Blob([bytes]);
    await expect(sha256Blob(blob)).resolves.toBe(reference(bytes));
  });

  it('hashes an empty Blob', async () => {
    await expect(sha256Blob(new Blob([]))).resolves.toBe(KNOWN_VECTORS[0]![1]);
  });

  it('verifies and rejects stored bytes against an expected digest', async () => {
    const bytes = randomBytes(2048);
    const blob = new Blob([bytes]);
    await expect(verifySha256(blob, reference(bytes))).resolves.toBe(true);
    await expect(verifySha256(blob, reference(randomBytes(2048)))).resolves.toBe(false);
  });

  it('rejects an invalid chunk size', async () => {
    await expect(sha256Blob(new Blob([new Uint8Array([1])]), 0)).rejects.toThrow(/chunk size/i);
  });
});
