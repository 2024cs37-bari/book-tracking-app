import { expect, test, type Page } from '@playwright/test';
import { buildEpubFixture, buildPdfFixture } from '../support/fixtures';
import { importBook, position } from './support';

async function sessions(page: Page): Promise<{ durationS: number; startedAt: number }[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('book-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ durationS: number; startedAt: number }[]>((resolve, reject) => {
        const request = db.transaction('sessions').objectStore('sessions').getAll();
        request.onsuccess = () => resolve(request.result.sort((a, b) => a.startedAt - b.startedAt));
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
}

async function visibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test('reading time resumes after visibility changes and excludes hidden spans', async ({
  page,
}) => {
  await page.clock.install();
  await importBook(
    page,
    buildPdfFixture({ title: 'Foreground sessions', pageCount: 4 }),
    'sessions.pdf',
    'Foreground sessions',
  );
  await page.clock.fastForward(10_000);
  await visibility(page, 'hidden');
  await expect.poll(async () => (await sessions(page)).length).toBe(1);
  const first = (await sessions(page))[0]!.durationS;
  await page.clock.fastForward(60_000);
  await visibility(page, 'visible');
  await page.clock.fastForward(20_000);
  await visibility(page, 'hidden');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect.poll(async () => (await sessions(page)).length).toBe(2);
  const all = await sessions(page);
  expect(first).toBeGreaterThanOrEqual(10);
  expect(all[1]!.durationS).toBeGreaterThanOrEqual(20);
  expect(all.reduce((sum, span) => sum + span.durationS, 0)).toBeLessThan(40);
});

test('failed progress save remains visible and reload recovers the journaled position', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Install before Dexie captures IndexedDB methods, but activate only after
  // the initial position is durable. Reload starts with a healthy store again.
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'progress' && document.documentElement.dataset.failProgress === 'true')
        throw new DOMException('Simulated storage quota failure', 'QuotaExceededError');
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
  });
  await importBook(
    page,
    buildEpubFixture({ title: 'Position recovery', chapters: 3, paragraphs: 80 }),
    'recovery.epub',
    'Position recovery',
  );
  await expect.poll(async () => (await position(page)).locatorKind).toBe('cfi');
  await page.evaluate(() => {
    document.documentElement.dataset.failProgress = 'true';
  });
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry saving position' })).toBeVisible();
  const intent = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((name) =>
      name.startsWith('book-reader:unsaved-position:v1:'),
    );
    if (!key) throw new Error('Unsaved position journal missing');
    return JSON.parse(localStorage.getItem(key)!) as { locator: { fraction: number } };
  });
  expect(intent.locator.fraction).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await expect
    .poll(async () => Math.abs((await position(page)).fraction - intent.locator.fraction))
    .toBeLessThan(0.03);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(localStorage).filter((name) =>
            name.startsWith('book-reader:unsaved-position:v1:'),
          ).length,
      ),
    )
    .toBe(0);
  expect(errors).toEqual([]);
});
