import { bytesToHex } from '~/domain/ids';

/**
 * Incremental SHA-256.
 *
 * Web Crypto can only digest a whole buffer at once, which forces an entire
 * book into memory before hashing. Books are the largest objects this app
 * handles, so the digest is computed incrementally instead, letting callers
 * stream Blob slices through it.
 */

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const BLOCK_SIZE = 64;

function rotateRight(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

export class Sha256 {
  private readonly state = new Uint32Array(INITIAL_STATE);
  private readonly block = new Uint8Array(BLOCK_SIZE);
  private readonly schedule = new Uint32Array(64);
  private blockLength = 0;
  private totalBytes = 0;
  private finalized = false;

  update(data: Uint8Array): this {
    if (this.finalized) {
      throw new Error('Sha256 has already been finalized and cannot accept more data.');
    }
    this.totalBytes += data.length;
    this.absorb(data);
    return this;
  }

  digest(): Uint8Array {
    if (this.finalized) {
      throw new Error('Sha256 has already been finalized.');
    }
    this.finalized = true;

    // Append 0x80, then zeros, then the 64-bit big-endian bit length so the
    // final block ends 8 bytes short of a full block boundary.
    const paddingLength =
      this.blockLength < 56 ? BLOCK_SIZE - this.blockLength : BLOCK_SIZE * 2 - this.blockLength;
    const padding = new Uint8Array(paddingLength);
    padding[0] = 0x80;
    const bitLength = this.totalBytes * 8;
    const paddingView = new DataView(padding.buffer);
    paddingView.setUint32(paddingLength - 8, Math.floor(bitLength / 0x100000000));
    paddingView.setUint32(paddingLength - 4, bitLength >>> 0);
    this.absorb(padding);

    const digest = new Uint8Array(32);
    const digestView = new DataView(digest.buffer);
    for (let index = 0; index < 8; index += 1) {
      digestView.setUint32(index * 4, this.state[index]!);
    }
    return digest;
  }

  hexDigest(): string {
    return bytesToHex(this.digest());
  }

  private absorb(data: Uint8Array): void {
    let offset = 0;

    if (this.blockLength > 0) {
      const needed = BLOCK_SIZE - this.blockLength;
      const taken = Math.min(needed, data.length);
      this.block.set(data.subarray(0, taken), this.blockLength);
      this.blockLength += taken;
      offset += taken;
      if (this.blockLength === BLOCK_SIZE) {
        this.compress(this.block, 0);
        this.blockLength = 0;
      }
    }

    while (offset + BLOCK_SIZE <= data.length) {
      this.compress(data, offset);
      offset += BLOCK_SIZE;
    }

    if (offset < data.length) {
      this.block.set(data.subarray(offset), 0);
      this.blockLength = data.length - offset;
    }
  }

  private compress(bytes: Uint8Array, offset: number): void {
    const schedule = this.schedule;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = schedule[index - 15]!;
      const previous2 = schedule[index - 2]!;
      const sigma0 =
        (rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3)) >>> 0;
      const sigma1 =
        (rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10)) >>> 0;
      schedule[index] = (schedule[index - 16]! + sigma0 + schedule[index - 7]! + sigma1) >>> 0;
    }

    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
      const choice = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + sum1 + choice + ROUND_CONSTANTS[index]! + schedule[index]!) >>> 0;
      const sum0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0;
    this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0;
    this.state[7] = (this.state[7]! + h) >>> 0;
  }
}

export function sha256Hex(data: Uint8Array): string {
  return new Sha256().update(data).hexDigest();
}

export function sha256Text(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}

export const DEFAULT_HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * Streams a Blob through the digest in chunks so peak memory stays bounded
 * regardless of book size.
 */
export async function sha256Blob(
  blob: Blob,
  chunkBytes = DEFAULT_HASH_CHUNK_BYTES,
): Promise<string> {
  if (!Number.isFinite(chunkBytes) || chunkBytes <= 0) {
    throw new Error('Hash chunk size must be a positive number of bytes.');
  }
  const hasher = new Sha256();
  let offset = 0;
  while (offset < blob.size) {
    const slice = blob.slice(offset, offset + chunkBytes);
    const chunk = new Uint8Array(await slice.arrayBuffer());
    if (chunk.length === 0) break;
    hasher.update(chunk);
    offset += chunk.length;
  }
  return hasher.hexDigest();
}

/** Confirms stored bytes still match the hash recorded in metadata. */
export async function verifySha256(blob: Blob, expectedSha256: string): Promise<boolean> {
  const actual = await sha256Blob(blob);
  return actual === expectedSha256;
}
