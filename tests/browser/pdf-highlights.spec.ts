import { expect, test, type Page } from '@playwright/test';
import { buildPdfFixture } from '../support/fixtures';
import { importBook } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

async function selectPageText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const layer = document.querySelector('.pdf-page .textLayer');
    if (!layer || layer.textContent?.trim() === '') throw new Error('No text layer to select');
    const range = document.createRange();
    range.selectNodeContents(layer);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

test('selecting PDF text creates a persistent highlight drawn over the page', async ({ page }) => {
  // PDF import, highlight, reload and re-render is heavy, especially on Firefox.
  test.slow();
  await importBook(
    page,
    buildPdfFixture({ title: 'Highlight PDF', pageCount: 3 }),
    'highlight.pdf',
    'Highlight PDF',
  );
  await expect(page.locator('.pdf-page .textLayer')).toContainText('Generated page 1');

  const panel = page.locator('.reader-bookmarks');
  await page.getByRole('tab', { name: 'Notes' }).click();
  const highlightButton = page.getByRole('button', { name: 'Highlight selection' });
  await expect(highlightButton).toBeVisible();

  await selectPageText(page);
  await expect(highlightButton).toBeEnabled();

  await highlightButton.click();
  await expect(panel.locator('.reader-bookmark-list li')).toHaveCount(1);
  await expect(panel.locator('.reader-annotation-kind')).toHaveText('Highlight');
  // The highlight is drawn as positioned boxes over the page.
  await expect
    .poll(() => page.locator('.pdf-highlight-layer .pdf-highlight').count())
    .toBeGreaterThan(0);

  // It persists and is redrawn after a reload once the text layer re-renders.
  await page.reload();
  await expect(page.locator('.pdf-page .textLayer')).toContainText('Generated page 1');
  await expect
    .poll(() => page.locator('.pdf-highlight-layer .pdf-highlight').count())
    .toBeGreaterThan(0);

  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('book-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<{ kind: string; locatorValue?: string; deleted: boolean }[]>(
      (resolve, reject) => {
        const request = db.transaction('annotations').objectStore('annotations').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    db.close();
    return rows;
  });
  const live = stored.filter((row) => !row.deleted);
  expect(live).toHaveLength(1);
  expect(live[0]!.kind).toBe('highlight');
  // Anchor encodes page:yOffset:start:end.
  expect(live[0]!.locatorValue).toMatch(/^0:\d+:\d+:\d+$/);

  // Deleting clears the overlay.
  await page.getByRole('tab', { name: 'Notes' }).click();
  await page.getByRole('button', { name: 'Delete highlight' }).click();
  await expect.poll(() => page.locator('.pdf-highlight-layer .pdf-highlight').count()).toBe(0);
});
