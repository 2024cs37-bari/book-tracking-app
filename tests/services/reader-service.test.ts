import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReaderService, ReaderSession } from '~/services/reader-service';
import { PositionJournal } from '~/services/position-journal';
import { BOOK_ALIAS_PREFIX } from '~/sync/identity';
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
  vi.unstubAllGlobals();
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
  readonly supportsHighlights = false;
  onSelection() {
    return () => {};
  }
  onContextMenu() {
    return () => {};
  }
  applyHighlights() {}
  readonly supportsThumbnails = false;
  async listPages() {
    return [];
  }
  async renderThumbnail() {
    return null;
  }
  async getVisibleText() {
    return '';
  }
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

it('retains a failed locator until retry succeeds and clears the failed state', async () => {
  const book = await imported();
  const renderer = new TestRenderer();
  const states: string[] = [];
  const session = new ReaderSession(renderer, book.id, harness.progress, vi.fn(), async () => {});
  session.onSaveState((state) => states.push(state));
  await session.open(toBlob(buildEpubFixture()), undefined, vi.fn());
  vi.spyOn(harness.progress, 'save').mockRejectedValueOnce(new Error('temporary quota issue'));
  const locator: Locator = { kind: 'cfi', value: 'epubcfi(/6/2)', fraction: 0.5 };
  renderer.emit(locator);
  await session.flush();
  expect(states.at(-1)).toBe('failed');
  await session.flush();
  expect((await harness.progress.get(book.id))?.locator).toEqual(locator);
  expect(states.at(-1)).toBe('saved');
  await session.close();
});

it('a failed older write never replaces a newer reading position', async () => {
  const book = await imported();
  const renderer = new TestRenderer();
  const session = new ReaderSession(renderer, book.id, harness.progress, vi.fn(), async () => {});
  await session.open(toBlob(buildEpubFixture()), undefined, vi.fn());
  let rejectWrite!: (error: Error) => void;
  vi.spyOn(harness.progress, 'save').mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectWrite = reject;
      }),
  );
  renderer.emit({ kind: 'cfi', value: 'epubcfi(/6/2)', fraction: 0.2 });
  const first = session.flush();
  await Promise.resolve();
  const latest: Locator = { kind: 'cfi', value: 'epubcfi(/6/8)', fraction: 0.8 };
  renderer.emit(latest);
  const second = session.flush();
  rejectWrite(new Error('failed earlier transaction'));
  await Promise.all([first, second]);
  expect((await harness.progress.get(book.id))?.locator).toEqual(latest);
  await session.close();
});

it('ignores repeated layout positions and keeps a failed save visible during retry', async () => {
  const book = await imported();
  const renderer = new TestRenderer();
  const states: string[] = [];
  const session = new ReaderSession(renderer, book.id, harness.progress, vi.fn(), async () => {});
  session.onSaveState((state) => states.push(state));
  await session.open(toBlob(buildEpubFixture()), undefined, vi.fn());
  const save = vi.spyOn(harness.progress, 'save').mockRejectedValueOnce(new Error('quota'));
  const locator: Locator = { kind: 'cfi', value: 'epubcfi(/6/2)', fraction: 0.5 };
  renderer.emit(locator);
  await session.flush();
  expect(states.at(-1)).toBe('failed');
  renderer.emit({ ...locator });
  expect(states.at(-1)).toBe('failed');
  const retry = session.flush();
  expect(states.at(-1)).toBe('failed');
  await retry;
  expect(states.at(-1)).toBe('saved');
  renderer.emit({ ...locator });
  await session.flush();
  expect(save).toHaveBeenCalledTimes(2);
  await session.close();
});

it('reopens at the unsaved intent after close fails without blocking navigation forever', async () => {
  const book = await imported();
  const renderers = createRendererRegistry([
    { format: 'epub', support: 'experimental', engine: 'test', create: () => new TestRenderer() },
  ]);
  const service = new ReaderService({
    ...harness,
    renderers,
    persistClock: async () => {},
    storageNamespace: harness.db.name,
  });
  const prepared = await service.prepare(book.id, vi.fn());
  await prepared.session.open(prepared.file, prepared.startAt, vi.fn());
  const locator: Locator = { kind: 'cfi', value: 'epubcfi(/6/12)', fraction: 0.9 };
  (prepared.session.renderer as TestRenderer).emit(locator);
  vi.spyOn(harness.progress, 'save').mockRejectedValueOnce(new Error('closing write failed'));
  await prepared.session.close();
  const reopened = await service.prepare(book.id, vi.fn());
  expect(reopened.startAt).toEqual(locator);
  await reopened.session.open(reopened.file, reopened.startAt, vi.fn());
  await reopened.session.flush();
  expect((await harness.progress.get(book.id))?.locator).toEqual(locator);
  await reopened.session.close();
});

it('reports malformed renderer positions without corrupting saved progress', async () => {
  const book = await imported();
  const renderer = new TestRenderer();
  const report = vi.fn();
  const session = new ReaderSession(renderer, book.id, harness.progress, report, async () => {});
  await session.open(toBlob(buildEpubFixture()), undefined, vi.fn());
  renderer.emit({ kind: 'cfi', value: '', fraction: 2 });
  await session.flush();
  expect(report).toHaveBeenCalledWith(expect.stringContaining('invalid position'));
  expect((await harness.progress.get(book.id))?.locator).toBeNull();
  await session.close();
});

it.each(['alias', 'canonical'] as const)(
  'replays an old alias journal from the %s route against the matching original',
  async (route) => {
    const book = await imported();
    const map = new Map<string, string>();
    const store: Storage = {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      key: (index) => [...map.keys()][index] ?? null,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => map.set(key, value),
      removeItem: (key: string) => map.delete(key),
    };
    vi.stubGlobal('window', { localStorage: store });
    const alias = 'old-book-id';
    await harness.db.syncMeta.put({ key: `${BOOK_ALIAS_PREFIX}${alias}`, value: book.id });
    const locator: Locator = { kind: 'cfi', value: 'epubcfi(/6/14)', fraction: 0.75 };
    const journal = new PositionJournal(harness.db.name, () => store);
    journal.write(alias, locator, book.sha256);
    const service = new ReaderService({
      ...harness,
      renderers: createRendererRegistry([
        {
          format: 'epub',
          support: 'experimental',
          engine: 'test',
          create: () => new TestRenderer(),
        },
      ]),
      persistClock: async () => {},
      storageNamespace: harness.db.name,
    });
    const prepared = await service.prepare(route === 'alias' ? alias : book.id, vi.fn());
    expect(prepared.bookId).toBe(book.id);
    expect(prepared.startAt).toEqual(locator);
    await prepared.session.open(prepared.file, prepared.startAt, vi.fn());
    await prepared.session.flush();
    expect((await harness.progress.get(book.id))?.locator).toEqual(locator);
    expect(map.size).toBe(0);
    await prepared.session.close();
  },
);

it('recovers a failed open-session save after sync replaces the book route', async () => {
  const book = await imported();
  const service = new ReaderService({
    ...harness,
    renderers: createRendererRegistry([
      { format: 'epub', support: 'experimental', engine: 'test', create: () => new TestRenderer() },
    ]),
    persistClock: async () => {},
    storageNamespace: harness.db.name,
  });
  const prepared = await service.prepare(book.id, vi.fn());
  await prepared.session.open(prepared.file, prepared.startAt, vi.fn());
  const original = (await harness.db.books.get(book.id))!;
  const canonicalId = 'new-canonical-reader-id';
  await harness.db.transaction(
    'rw',
    harness.db.books,
    harness.db.progress,
    harness.db.syncMeta,
    async () => {
      const previousProgress = (await harness.db.progress.get(book.id))!;
      await harness.db.progress.delete(book.id);
      await harness.db.progress.put({ ...previousProgress, bookId: canonicalId });
      await harness.db.books.delete(book.id);
      await harness.db.books.add({ ...original, id: canonicalId });
      await harness.db.syncMeta.put({ key: `${BOOK_ALIAS_PREFIX}${book.id}`, value: canonicalId });
    },
  );
  const locator: Locator = { kind: 'cfi', value: 'epubcfi(/6/12!/4/2)', fraction: 0.9 };
  (prepared.session.renderer as TestRenderer).emit(locator);
  vi.spyOn(harness.progress, 'save').mockRejectedValueOnce(new Error('disk unavailable'));
  await prepared.session.close();
  const reopened = await service.prepare(canonicalId, vi.fn());
  expect(reopened.startAt).toEqual(locator);
  await reopened.session.open(reopened.file, reopened.startAt, vi.fn());
  await reopened.session.flush();
  expect((await harness.progress.get(canonicalId))?.locator).toEqual(locator);
  await reopened.session.close();
});

it('does not persist automatic startup relocations while a conflict choice is pending', async () => {
  const book = await imported();
  const renderer = new TestRenderer();
  const session = new ReaderSession(renderer, book.id, harness.progress, vi.fn(), async () => {});
  session.suspendSaving();
  await session.open(toBlob(buildEpubFixture()), undefined, vi.fn());
  const save = vi.spyOn(harness.progress, 'save');
  renderer.emit({ kind: 'cfi', value: 'epubcfi(/6/2)', fraction: 0.2 });
  await session.flush();
  expect(save).not.toHaveBeenCalled();
  await session.resumeSaving(true);
  expect((await harness.progress.get(book.id))?.locator?.fraction).toBe(0.2);
  await session.close();
});
