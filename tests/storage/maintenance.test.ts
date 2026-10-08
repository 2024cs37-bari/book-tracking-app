import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookFileKey, coverFileKey } from '~/storage/file-store';
import { inspectStorage, removeStoredFiles } from '~/storage/maintenance';
import { createHarness, type TestHarness } from '../support/harness';
import { buildEpubFixture, toBlob } from '../support/fixtures';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

async function importEpub(filename: string, withCover = false): Promise<string> {
  const outcome = await harness.imports.importFile({
    blob: toBlob(buildEpubFixture({ withCover })),
    filename,
  });
  if (outcome.status !== 'imported') throw new Error(`Expected an import, got ${outcome.status}.`);
  return outcome.book.id;
}

describe('storage reconciliation', () => {
  it('reports nothing when every stored file is referenced', async () => {
    await importEpub('clean.epub', true);
    const report = await inspectStorage(harness.db, harness.files);
    expect(report.orphanKeys).toEqual([]);
    expect(report.unreachableBooks).toEqual([]);
  });

  it('reports bytes written but never referenced, such as after a crash', async () => {
    await importEpub('referenced.epub');
    await harness.files.put(bookFileKey('a'.repeat(64)), toBlob(new Uint8Array([1, 2, 3, 4])));

    const report = await inspectStorage(harness.db, harness.files);
    expect(report.orphanKeys).toEqual([bookFileKey('a'.repeat(64))]);
    expect(report.orphanBytes).toBe(4);
  });

  it('reports books whose original file is missing locally', async () => {
    const bookId = await importEpub('missing.epub');
    const book = await harness.books.getById(bookId);
    await harness.files.remove(bookFileKey(book!.sha256));

    const report = await inspectStorage(harness.db, harness.files);
    expect(report.unreachableBooks).toEqual([{ bookId, sha256: book!.sha256 }]);
  });

  it('does not treat a cover as an orphan', async () => {
    const bookId = await importEpub('with-cover.epub', true);
    const book = await harness.books.getById(bookId);

    const report = await inspectStorage(harness.db, harness.files);
    expect(book?.coverKey).toBe(coverFileKey(bookId, 'jpg'));
    expect(report.orphanKeys).toEqual([]);
  });

  it('ignores books that were soft-deleted when computing references', async () => {
    const bookId = await importEpub('deleted.epub');
    const book = await harness.books.getById(bookId);
    await harness.books.setLifecycle(bookId, 'deleted');

    const report = await inspectStorage(harness.db, harness.files);
    expect(report.orphanKeys).toContain(bookFileKey(book!.sha256));
  });

  it('removes only the keys it was asked to remove', async () => {
    const bookId = await importEpub('keep.epub');
    const book = await harness.books.getById(bookId);
    const strayKey = bookFileKey('b'.repeat(64));
    await harness.files.put(strayKey, toBlob(new Uint8Array([9, 9])));

    const report = await inspectStorage(harness.db, harness.files);
    expect(await removeStoredFiles(harness.files, report.orphanKeys)).toBe(1);

    expect(await harness.files.has(strayKey)).toBe(false);
    expect(await harness.files.has(bookFileKey(book!.sha256))).toBe(true);
  });
});
