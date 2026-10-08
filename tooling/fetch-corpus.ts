import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { CORPUS } from './corpus-manifest.ts';
import { corpusDirectory, verifyCorpusBytes } from './corpus-files.ts';

const directory = corpusDirectory();
// Node's 250 ms address-family fallback can abandon a reachable IPv4 host
// before connecting, then fail on a runner with no IPv6 route.
setDefaultAutoSelectFamilyAttemptTimeout(3000);
const location = relative(fileURLToPath(new URL('../', import.meta.url)), directory);
if (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`))
  throw new Error('BOOK_CORPUS_DIR must be outside the repository. Never commit book files.');
await mkdir(directory, { recursive: true });
for (const sample of CORPUS) {
  const destination = resolve(directory, sample.filename);
  const cached = await readFile(destination).catch(() => null);
  if (cached) {
    verifyCorpusBytes(sample, cached);
    console.info(`${sample.id}: verified cached original (${cached.length} bytes)`);
    continue;
  }
  const response = await fetch(sample.url, {
    signal: AbortSignal.timeout(120_000),
    headers: {
      // Some upstream document hosts reject Node's default "node" user agent.
      'User-Agent':
        'Mozilla/5.0 (compatible; BookTrackingCorpus/1.0; +https://github.com/2024cs37-bari/book-tracking-app)',
      Accept: 'application/pdf,application/epub+zip,application/octet-stream;q=0.9,*/*;q=0.5',
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 240);
    throw new Error(`${sample.id}: download failed with HTTP ${response.status}: ${detail}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body!) {
    size += chunk.length;
    if (size > sample.maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${sample.id}: download exceeds corpus size limit`);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  verifyCorpusBytes(sample, bytes);
  await writeFile(`${destination}.part`, bytes);
  await rename(`${destination}.part`, destination);
  console.info(`${sample.id}: fetched and verified (${bytes.length} bytes)`);
}
await writeFile(
  resolve(directory, 'PROVENANCE.json'),
  JSON.stringify({ samples: CORPUS }, null, 2),
);
console.info(
  `Corpus directory: ${directory}. Originals are unmodified; license/attribution notices remain embedded.`,
);
