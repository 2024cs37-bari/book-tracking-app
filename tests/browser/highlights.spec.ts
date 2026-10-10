import { expect, test, type Frame } from '@playwright/test';
import { buildEpubFixture } from '../support/fixtures';
import { importBook } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

/** Selects the first paragraph inside the live book frame and announces it. */
async function selectFirstParagraph(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const paragraph = document.querySelector('p');
    if (!paragraph) throw new Error('No paragraph to select');
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

test('selecting text creates a persistent highlight with a drawn overlay', async ({ page }) => {
  await importBook(
    page,
    buildEpubFixture({ title: 'Highlighted Reader', chapters: 1, paragraphs: 6 }),
    'highlighted.epub',
    'Highlighted Reader',
  );

  const panel = page.locator('.reader-bookmarks');
  await panel.locator('summary').click();
  // Highlighting is offered for EPUB; the control is disabled until a selection.
  const highlightButton = page.getByRole('button', { name: 'Highlight selection' });
  await expect(highlightButton).toBeVisible();
  await expect(highlightButton).toBeDisabled();

  await expect
    .poll(() => page.frames().filter((frame) => frame.url().startsWith('blob:')).length)
    .toBeGreaterThan(0);
  const frame = page.frames().find((frame) => frame.url().startsWith('blob:'))!;

  await selectFirstParagraph(frame);
  await expect(highlightButton).toBeEnabled();

  await highlightButton.click();
  await expect(panel.locator('summary')).toContainText('(1)');
  await expect(panel.locator('.reader-annotation-kind')).toHaveText('Highlight');
  // The overlay itself is drawn into foliate's closed shadow root, which cannot
  // be inspected from a test; its creation is asserted via the stored annotation
  // and the absence of any page error from the draw path (see afterEach).

  // The highlight persists across a reload and is re-applied on open.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await panel.locator('summary').click();
  await expect(panel.locator('summary')).toContainText('(1)');
  await expect(panel.locator('.reader-annotation-kind')).toHaveText('Highlight');

  // The stored annotation is a non-deleted highlight carrying its excerpt.
  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('book-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<{ kind: string; textExcerpt?: string; deleted: boolean }[]>(
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
  expect((live[0]!.textExcerpt ?? '').length).toBeGreaterThan(0);

  // Deleting removes the row and the list entry.
  await page.getByRole('button', { name: 'Delete highlight' }).click();
  await expect(panel.locator('.reader-bookmark-list li')).toHaveCount(0);
  await expect(panel.locator('summary')).toContainText('(0)');
});
