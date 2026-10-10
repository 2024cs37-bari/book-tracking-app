import { expect, test, type Page } from '@playwright/test';
import { buildEpubFixture } from '../support/fixtures';
import { importBook } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

/** Writes a pending progress-divergence row for the only book, as sync would. */
async function seedConflict(page: Page, remoteFraction: number): Promise<void> {
  await page.evaluate(async (fraction) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('book-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const bookId = await new Promise<string>((resolve, reject) => {
      const request = db.transaction('books').objectStore('books').getAllKeys();
      request.onsuccess = () => resolve(request.result[0] as string);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('progressConflicts', 'readwrite');
      tx.objectStore('progressConflicts').put({
        bookId,
        remote: {
          bookId,
          status: 'reading',
          locatorKind: 'cfi',
          locatorValue: 'epubcfi(/6/4!/4/2/2)',
          fraction,
          updatedHlc: '4000000000000:0:other-device',
          deviceId: 'other-device',
        },
        localFraction: 0,
        localUpdatedHlc: '1700000000000:0:this-device',
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, remoteFraction);
}

async function pendingCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('book-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const request = db.transaction('progressConflicts').objectStore('progressConflicts').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return count;
  });
}

test('a pending progress divergence prompts in the reader and "Stay here" dismisses it', async ({
  page,
}) => {
  await importBook(
    page,
    buildEpubFixture({ title: 'Diverged Book', chapters: 1, paragraphs: 6 }),
    'diverged.epub',
    'Diverged Book',
  );

  await seedConflict(page, 0.8);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();

  const banner = page.getByRole('alertdialog', { name: 'Reading position differs' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('80%');

  await banner.getByRole('button', { name: 'Stay here' }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => pendingCount(page)).toBe(0);
});

test('"Go to" accepts the other device\'s position and clears the prompt', async ({ page }) => {
  await importBook(
    page,
    buildEpubFixture({ title: 'Jump Book', chapters: 1, paragraphs: 6 }),
    'jump.epub',
    'Jump Book',
  );

  await seedConflict(page, 0.6);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();

  const banner = page.getByRole('alertdialog', { name: 'Reading position differs' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: /^Go to/ }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => pendingCount(page)).toBe(0);
});
