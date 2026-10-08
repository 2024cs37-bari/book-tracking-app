import { expect, it } from 'vitest';
import { CORPUS } from '../../tooling/corpus-manifest';
import { verifyCorpusBytes } from '../../tooling/corpus-files';

it('rejects tampered upstream bytes before they can be used as a corpus fixture', () => {
  expect(() => verifyCorpusBytes(CORPUS[0], new TextEncoder().encode('tampered archive'))).toThrow(
    'SHA-256 mismatch',
  );
});

it('rejects an oversized upstream download before hashing or rendering it', () => {
  expect(() => verifyCorpusBytes(CORPUS[0], new Uint8Array(CORPUS[0].maxBytes + 1))).toThrow(
    'size limit',
  );
});
