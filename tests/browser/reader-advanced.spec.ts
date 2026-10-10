import { expect, test, type Page } from '@playwright/test';
import { buildPdfFixture } from '../support/fixtures';
import { importBook } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

/** Selects the first PDF page's text layer and announces it to the reader. */
async function selectPageText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const layer = document.querySelector('.pdf-page .textLayer');
    if (!layer || layer.textContent?.trim() === '') throw new Error('No text layer to select');
    const range = document.createRange();
    range.selectNodeContents(layer);
    const selection = document.getSelection();
    if (!selection) throw new Error('No selection API');
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

/** Reads the stored (non-deleted) highlight colours straight from IndexedDB. */
async function storedHighlightColours(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('book-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<{ kind: string; color?: string; deleted: boolean }[]>(
      (resolve, reject) => {
        const request = db.transaction('annotations').objectStore('annotations').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    db.close();
    return rows
      .filter((row) => !row.deleted && row.kind === 'highlight')
      .map((row) => row.color ?? '');
  });
}

test('the Listen panel exposes a read-aloud control', async ({ page }) => {
  await importBook(
    page,
    buildPdfFixture({ title: 'Listen PDF', pageCount: 1 }),
    'listen.pdf',
    'Listen PDF',
  );
  await expect(page.locator('.pdf-page .textLayer')).toContainText('Generated page 1');

  await page.getByRole('tab', { name: 'Listen' }).click();
  // Either the live control (speech synthesis available) or the graceful
  // fallback renders — both prove the panel is wired without a network call.
  const readAloud = page.getByRole('region', { name: 'Read aloud' });
  const fallback = page.getByText('Read-aloud is not available in this browser.');
  await expect(readAloud.or(fallback)).toBeVisible();
});

test('a highlight can be recoloured from the annotations panel', async ({ page }) => {
  test.slow();
  await importBook(
    page,
    buildPdfFixture({ title: 'Recolour PDF', pageCount: 1 }),
    'recolour.pdf',
    'Recolour PDF',
  );
  await expect(page.locator('.pdf-page .textLayer')).toContainText('Generated page 1');

  await page.getByRole('tab', { name: 'Notes' }).click();
  const panel = page.locator('.reader-notes-panel');
  const highlightButton = page.getByRole('button', { name: 'Highlight selection' });

  await selectPageText(page);
  await expect(highlightButton).toBeEnabled();
  await highlightButton.click();
  await expect(panel.locator('.reader-annotation-list li')).toHaveCount(1);
  expect(await storedHighlightColours(page)).toEqual(['yellow']);

  // Open the per-highlight palette and pick green.
  await panel.getByRole('button', { name: 'Change highlight colour' }).click();
  await panel.getByRole('button', { name: 'Green', exact: true }).click();

  await expect.poll(() => storedHighlightColours(page)).toEqual(['green']);
});
