import { expect, test } from '@playwright/test';
import { buildEpubFixture } from '../support/fixtures';
import { importBook } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('bookmarks and notes are created, annotated, persisted across reload, and deleted', async ({
  page,
}) => {
  await importBook(
    page,
    buildEpubFixture({ title: 'Annotated Reader', chapters: 2, paragraphs: 20 }),
    'annotated.epub',
    'Annotated Reader',
  );

  const panel = page.locator('.reader-bookmarks');
  await panel.locator('summary').click();
  await expect(panel.locator('summary')).toContainText('(0)');

  // Bookmark the opening position.
  await page.getByRole('button', { name: 'Bookmark this position' }).click();
  await expect(panel.locator('.reader-bookmark-list li')).toHaveCount(1);
  await expect(panel.locator('summary')).toContainText('(1)');
  // The jump control is labelled with the position fraction.
  await expect(panel.locator('.reader-bookmark-go')).toContainText('%');

  // Attach a note; the input commits on change (blur).
  const note = panel.locator('.reader-bookmark-note');
  await note.fill('Return to this argument');
  await note.blur();

  // The annotation and its note survive a full reload (loaded from IndexedDB).
  await page.reload();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await panel.locator('summary').click();
  await expect(panel.locator('summary')).toContainText('(1)');
  await expect(panel.locator('.reader-bookmark-note')).toHaveValue('Return to this argument');

  // The annotation also persists as a non-deleted row in the annotations store.
  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('book-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<{ kind: string; note?: string; deleted: boolean }[]>(
      (resolve, reject) => {
        const request = db.transaction('annotations').objectStore('annotations').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    db.close();
    return rows;
  });
  expect(stored.filter((row) => !row.deleted)).toHaveLength(1);
  expect(stored.find((row) => !row.deleted)?.kind).toBe('bookmark');
  expect(stored.find((row) => !row.deleted)?.note).toBe('Return to this argument');

  // Deleting removes it from the list and tombstones the row.
  await page.getByRole('button', { name: 'Delete bookmark' }).click();
  await expect(panel.locator('.reader-bookmark-list li')).toHaveCount(0);
  await expect(panel.locator('summary')).toContainText('(0)');
});
