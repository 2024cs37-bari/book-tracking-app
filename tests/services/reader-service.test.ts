import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReaderService, ReaderSession } from '~/services/reader-service';
import { createRendererRegistry, type Renderer } from '~/reader/renderer';
import type { Locator } from '~/domain/locator';
import { bookFileKey } from '~/storage/file-store';
import { buildEpubFixture, buildMobiFixture, toBlob } from '../support/fixtures';
import { createHarness, type TestHarness } from '../support/harness';

let harness: TestHarness;
beforeEach(async () => {
  harness = await createHarness();
});
afterEach(async () => {
  vi.useRealTimers();
  await harness.close();
});

class TestRenderer implements Renderer {
  callback?: (locator: Locator, fraction: number) => void;
  mount() {}
  open = vi.fn(async () => {});
  goTo() {}
  prev() {}
  next() {}
  async getToc() {
    return [];
  }
  search(): AsyncIterable<never> {
    return {
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    };
  }
  applySettings() {}
  destroy = vi.fn();
  onRelocate(callback: (locator: Locator, fraction: number) => void) {
    this.callback = callback;
    return () => {
      this.callback = undefined;
    };
  }
  emit(locator: Locator) {
    this.callback?.(locator, locator.fraction);
  }
}

async function imported() {
  const result = await harness.imports.importFile({
    blob: toBlob(buildEpubFixture()),
    filename: 'reader.epub',
  });
  if (result.status !== 'imported') throw new Error('Fixture import failed');
  return result.book;
}

it('debounces progress, flushes on close and writes the final locator with its outbox row', async () => {
  const book = await imported();
  const renderer = new TestRenderer();
  const session = new ReaderSession(renderer, book.id, harness.progress, vi.fn(), async () => {});
  const before = await harness.db.changes.count();
  await session.open(toBlob(buildEpubFixture()), undefined, vi.fn());
  const save = vi.spyOn(harness.progress, 'save');
  for (let index = 1; index <= 10; index++)
    renderer.emit({ kind: 'cfi', value: `epubcfi(/6/${index})`, fraction: index / 10 });
  expect(save).not.toHaveBeenCalled();
  await session.close();
  expect(renderer.destroy).toHaveBeenCalledOnce();
  expect(await harness.db.changes.count()).toBe(before + 1);
  const saved = await harness.progress.get(book.id);
  expect(saved?.locator?.fraction).toBe(1);
  const outbox = await harness.db.changes.where('entity').equals('progress').toArray();
  expect(outbox.map((change) => JSON.parse(change.payload))).toContainEqual(
    expect.objectContaining({ locatorValue: 'epubcfi(/6/10)', fraction: 1 }),
  );
});

it('flushes on debounce and restores the saved native locator when preparing a new session', async () => {
  const book = await imported();
  const renderer = new TestRenderer();
  const session = new ReaderSession(renderer, book.id, harness.progress, vi.fn(), async () => {});
  await session.open(toBlob(buildEpubFixture()), undefined, vi.fn());
  const locator: Locator = { kind: 'cfi', value: 'epubcfi(/6/2)', fraction: 0.4 };
  renderer.emit(locator);
  await new Promise((resolve) => setTimeout(resolve, 450));
  await session.flush();
  const renderers = createRendererRegistry([
    { format: 'epub', support: 'experimental', engine: 'test', create: () => new TestRenderer() },
  ]);
  const service = new ReaderService({ ...harness, renderers, persistClock: async () => {} });
  const prepared = await service.prepare(book.id, vi.fn());
  expect(prepared.startAt).toEqual(locator);
  expect((await harness.deviceState.get(book.id))?.lastOpenedAt).toBeGreaterThan(0);
  await prepared.session.open(prepared.file, prepared.startAt, vi.fn());
  const newer: Locator = { kind: 'cfi', value: 'epubcfi(/6/4)', fraction: 0.6 };
  (prepared.session.renderer as TestRenderer).emit(newer);
  // Navigation cleanup starts a flush without awaiting it. Prepare must wait.
  void prepared.session.close();
  const reopened = await service.prepare(book.id, vi.fn());
  expect(reopened.startAt).toEqual(newer);
  await reopened.session.close();
  await session.close();
});

it('rejects unsupported formats and missing bytes without pretending to open', async () => {
  const result = await harness.imports.importFile({
    blob: toBlob(buildMobiFixture()),
    filename: 'legacy.mobi',
  });
  if (result.status !== 'imported') throw new Error('Fixture import failed');
  const service = new ReaderService({
    ...harness,
    renderers: createRendererRegistry(),
    persistClock: async () => {},
  });
  await expect(service.prepare(result.book.id, vi.fn())).rejects.toThrow('not implemented');
  const book = await imported();
  await harness.files.remove(bookFileKey(book.sha256));
  const renderers = createRendererRegistry([
    { format: 'epub', support: 'experimental', engine: 'test', create: () => new TestRenderer() },
  ]);
  const registered = new ReaderService({ ...harness, renderers, persistClock: async () => {} });
  await expect(registered.prepare(book.id, vi.fn())).rejects.toThrow('missing');
});

it('reports a failed durable save rather than silently losing the position', async () => {
  const book = await imported();
  const renderer = new TestRenderer();
  const report = vi.fn();
  const session = new ReaderSession(renderer, book.id, harness.progress, report, async () => {});
  await session.open(toBlob(buildEpubFixture()), undefined, vi.fn());
  vi.spyOn(harness.progress, 'save').mockRejectedValueOnce(new Error('Quota exceeded'));
  renderer.emit({ kind: 'cfi', value: 'epubcfi(/6/2)', fraction: 0.5 });
  await session.close();
  expect(report).toHaveBeenCalledWith(expect.stringContaining('Quota exceeded'));
});
