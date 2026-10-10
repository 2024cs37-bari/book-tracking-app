import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookFileKey, coverFileKey } from '~/storage/file-store';
import { sha256Blob } from '~/storage/sha256';
import { createHarness, type TestHarness } from '../support/harness';
import {
  buildEpubFixture,
  buildFb2Fixture,
  buildMobiFixture,
  buildPdfFixture,
  buildPlainTextFixture,
  toBlob,
} from '../support/fixtures';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

describe('EPUB import', () => {
  it('records metadata, bytes and reading state from one file', async () => {
    const bytes = buildEpubFixture({
      title: 'The Synthetic Book',
      creator: 'Ada Author',
      language: 'fr',
      publisher: 'Synthetic House',
      identifier: 'urn:isbn:9780306406157',
    });
    const blob = toBlob(bytes);

    const outcome = await harness.imports.importFile({ blob, filename: 'synthetic.epub' });

    expect(outcome.status).toBe('imported');
    if (outcome.status !== 'imported') return;

    const { book } = outcome;
    expect(book.title).toBe('The Synthetic Book');
    expect(book.author).toBe('Ada Author');
    expect(book.language).toBe('fr');
    expect(book.publisher).toBe('Synthetic House');
    expect(book.isbn).toBe('9780306406157');
    expect(book.format).toBe('epub');
    expect(book.lifecycle).toBe('active');
    expect(book.metadataIncomplete).toBe(false);
    expect(book.sizeBytes).toBe(blob.size);
    expect(book.sha256).toBe(await sha256Blob(blob));

    // Original bytes are stored under their content hash.
    expect(await harness.files.has(bookFileKey(book.sha256))).toBe(true);
    const stored = await harness.files.get(bookFileKey(book.sha256));
    expect(await sha256Blob(stored)).toBe(book.sha256);
  });

  it('stores the cover as a derivative keyed by book id', async () => {
    const bytes = buildEpubFixture({ withCover: true });
    const outcome = await harness.imports.importFile({
      blob: toBlob(bytes),
      filename: 'covered.epub',
    });

    expect(outcome.status).toBe('imported');
    if (outcome.status !== 'imported') return;

    expect(outcome.book.coverKey).toBe(coverFileKey(outcome.book.id, 'jpg'));
    expect(await harness.files.has(outcome.book.coverKey!)).toBe(true);
    const cover = await harness.files.get(outcome.book.coverKey!);
    expect(cover.type).toBe('image/jpeg');
  });

  it('imports without a cover when the declared image is absent', async () => {
    const bytes = buildEpubFixture({ withCover: true, coverFileMissing: true });
    const outcome = await harness.imports.importFile({
      blob: toBlob(bytes),
      filename: 'no-cover.epub',
    });

    expect(outcome.status).toBe('imported');
    if (outcome.status !== 'imported') return;
    expect(outcome.book.coverKey).toBeUndefined();
    expect(outcome.warnings.join(' ')).toMatch(/cover image .* is not present/i);
  });

  it('falls back to the filename and flags incomplete metadata when the title is missing', async () => {
    const bytes = buildEpubFixture({ title: '' });
    const outcome = await harness.imports.importFile({
      blob: toBlob(bytes),
      filename: 'Some Obscure Title.epub',
    });

    expect(outcome.status).toBe('imported');
    if (outcome.status !== 'imported') return;
    expect(outcome.book.title).toBe('Some Obscure Title');
    expect(outcome.book.metadataIncomplete).toBe(true);
  });

  it('still imports a damaged EPUB, reporting why metadata was not read', async () => {
    const bytes = buildEpubFixture({ omitContainer: true });
    const outcome = await harness.imports.importFile({
      blob: toBlob(bytes),
      filename: 'damaged.epub',
    });

    expect(outcome.status).toBe('imported');
    if (outcome.status !== 'imported') return;
    expect(outcome.book.metadataIncomplete).toBe(true);
    expect(outcome.book.title).toBe('damaged');
    expect(outcome.warnings.join(' ')).toMatch(/container\.xml/i);
  });

  it('warns that reading is not implemented for deferred formats', async () => {
    const outcome = await harness.imports.importFile({
      blob: toBlob(buildFb2Fixture()),
      filename: 'book.fb2',
    });

    expect(outcome.status).toBe('imported');
    if (outcome.status !== 'imported') return;
    expect(outcome.book.format).toBe('fb2');
    expect(outcome.warnings.join(' ')).toMatch(/not implemented yet/i);
  });

  it('warns that reading is not implemented for MOBI/KF8 until an adapter exists', async () => {
    const outcome = await harness.imports.importFile({
      blob: toBlob(buildMobiFixture()),
      filename: 'book.mobi',
    });

    expect(outcome.status).toBe('imported');
    if (outcome.status !== 'imported') return;
    expect(outcome.book.format).toBe('mobi');
    expect(outcome.warnings.join(' ')).toMatch(/not implemented yet/i);
  });

  it('warns that EPUB reading support is still experimental', async () => {
    const outcome = await harness.imports.importFile({
      blob: toBlob(buildEpubFixture()),
      filename: 'experimental.epub',
    });

    expect(outcome.status).toBe('imported');
    if (outcome.status !== 'imported') return;
    expect(outcome.warnings.join(' ')).toMatch(/experimental/i);
  });
});

describe('PDF import', () => {
  it('reads title, author and page count from the information dictionary', async () => {
    const bytes = buildPdfFixture({
      title: 'A Synthetic Report',
      author: 'Grace Writer',
      pageCount: 3,
    });
    const outcome = await harness.imports.importFile({
      blob: toBlob(bytes),
      filename: 'report.pdf',
    });

    expect(outcome.status).toBe('imported');
    if (outcome.status !== 'imported') return;
    expect(outcome.book.format).toBe('pdf');
    expect(outcome.book.title).toBe('A Synthetic Report');
    expect(outcome.book.author).toBe('Grace Writer');
    expect(outcome.book.pageCount).toBe(3);
  });

  it('imports a PDF with no metadata using its filename', async () => {
    const bytes = buildPdfFixture({ withInfoDictionary: false, pageCount: 2 });
    const outcome = await harness.imports.importFile({
      blob: toBlob(bytes),
      filename: 'Untitled Scan.pdf',
    });

    expect(outcome.status).toBe('imported');
    if (outcome.status !== 'imported') return;
    expect(outcome.book.title).toBe('Untitled Scan');
    expect(outcome.book.pageCount).toBe(2);
    expect(outcome.book.metadataIncomplete).toBe(true);
  });
});

describe('duplicate detection', () => {
  it('links a re-import to the existing book instead of duplicating it', async () => {
    const bytes = buildEpubFixture({ title: 'Twice' });
    const first = await harness.imports.importFile({ blob: toBlob(bytes), filename: 'a.epub' });
    const second = await harness.imports.importFile({ blob: toBlob(bytes), filename: 'b.epub' });

    expect(first.status).toBe('imported');
    expect(second.status).toBe('duplicate');
    if (first.status !== 'imported' || second.status !== 'duplicate') return;
    expect(second.book.id).toBe(first.book.id);
    expect(await harness.books.list()).toHaveLength(1);
  });

  it('treats byte-identical files with different names as one book', async () => {
    const bytes = buildEpubFixture();
    await harness.imports.importFile({ blob: toBlob(bytes), filename: 'original.epub' });
    const renamed = await harness.imports.importFile({
      blob: toBlob(bytes),
      filename: 'a different name.epub',
    });

    expect(renamed.status).toBe('duplicate');
    expect(await harness.books.list()).toHaveLength(1);
  });

  it('imports distinct files separately', async () => {
    await harness.imports.importFile({
      blob: toBlob(buildEpubFixture({ title: 'One' })),
      filename: 'one.epub',
    });
    await harness.imports.importFile({
      blob: toBlob(buildEpubFixture({ title: 'Two' })),
      filename: 'two.epub',
    });
    expect(await harness.books.list()).toHaveLength(2);
  });

  it('produces exactly one book when the same bytes appear twice in one batch', async () => {
    const bytes = buildEpubFixture({ title: 'Batched' });
    const outcomes = await harness.imports.importFiles([
      { blob: toBlob(bytes), filename: 'first.epub' },
      { blob: toBlob(bytes), filename: 'second.epub' },
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['duplicate', 'imported']);
    expect(await harness.books.list()).toHaveLength(1);
  });
});

describe('unsupported input', () => {
  it('rejects content that is not a recognised book', async () => {
    const outcome = await harness.imports.importFile({
      blob: toBlob(buildPlainTextFixture('just some notes')),
      filename: 'notes.txt',
    });

    expect(outcome.status).toBe('unsupported');
    if (outcome.status !== 'unsupported') return;
    expect(outcome.filename).toBe('notes.txt');
    expect(await harness.books.list()).toHaveLength(0);
    expect(await harness.changes.pendingCount()).toBe(0);
  });

  it('leaves the library untouched when a file cannot be read', async () => {
    const unreadable = {
      size: 10,
      slice: () => ({
        arrayBuffer: () => Promise.reject(new Error('read failure')),
      }),
    } as unknown as Blob;

    const outcome = await harness.imports.importFile({ blob: unreadable, filename: 'broken.epub' });

    expect(outcome.status).toBe('failed');
    expect(await harness.books.list()).toHaveLength(0);
  });
});

describe('batch import', () => {
  it('reports every outcome and keeps going after a rejection', async () => {
    const seen: string[] = [];
    const outcomes = await harness.imports.importFiles(
      [
        { blob: toBlob(buildEpubFixture({ title: 'Good One' })), filename: 'good.epub' },
        { blob: toBlob(buildPlainTextFixture('nope')), filename: 'notes.txt' },
        { blob: toBlob(buildPdfFixture({ title: 'Good Two' })), filename: 'good.pdf' },
      ],
      (outcome) => seen.push(outcome.status),
    );

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'imported',
      'unsupported',
      'imported',
    ]);
    expect(seen).toEqual(['imported', 'unsupported', 'imported']);
    expect(await harness.books.list()).toHaveLength(2);
  });
});
