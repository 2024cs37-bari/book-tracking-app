import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { CORPUS } from './corpus-manifest.ts';

export const corpusDirectory = (): string =>
  resolve(process.env.BOOK_CORPUS_DIR ?? resolve(tmpdir(), 'book-tracking-corpus-v1'));
export type CorpusSample = (typeof CORPUS)[number];
export function verifyCorpusBytes(sample: CorpusSample, bytes: Uint8Array): void {
  if (bytes.byteLength > sample.maxBytes)
    throw new Error(`${sample.id}: corpus size limit exceeded`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sample.sha256)
    throw new Error(`${sample.id}: SHA-256 mismatch: expected ${sample.sha256}, got ${actual}`);
}
export async function readCorpusSample(sample: CorpusSample): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await readFile(resolve(corpusDirectory(), sample.filename)).catch(
    (error: unknown) => {
      throw new Error(
        `Corpus file ${sample.filename} unavailable. Run npm run corpus:fetch first. ${String(error)}`,
      );
    },
  );
  verifyCorpusBytes(sample, bytes);
  return new Uint8Array(bytes);
}
