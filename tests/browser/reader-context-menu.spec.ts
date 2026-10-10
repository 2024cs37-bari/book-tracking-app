import { expect, test, type Page } from '@playwright/test';
import { buildPdfFixture } from '../support/fixtures';
import { importBook } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

/** Selects the first page's text layer and announces it to the reader shell. */
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

/**
 * Fires a bubbling contextmenu from inside the page's text layer, as a real
 * right click over the selection would. The PDF text layer lives in the host
 * document, so the event reaches the reader surface.
 */
async function openContextMenu(page: Page): Promise<void> {
  await page.locator('.pdf-page .textLayer').dispatchEvent('contextmenu', { bubbles: true });
}

test('a selection context menu offers Highlight, Bookmark, and Copy', async ({ page }) => {
  // PDF import and render is heavy, especially on Firefox and WebKit.
  test.slow();
  await importBook(
    page,
    buildPdfFixture({ title: 'Context Menu PDF', pageCount: 2 }),
    'context-menu.pdf',
    'Context Menu PDF',
  );
  await expect(page.locator('.pdf-page .textLayer')).toContainText('Generated page 1');

  // The Notes panel's Highlight control doubles as a readiness signal: it is
  // only enabled once a selection has reached the reader shell.
  await page.getByRole('tab', { name: 'Notes' }).click();
  const notesPanel = page.locator('.reader-bookmarks');
  const highlightReady = page.getByRole('button', { name: 'Highlight selection' });
  await expect(highlightReady).toBeDisabled();

  await selectPageText(page);
  await expect(highlightReady).toBeEnabled();

  const menu = page.getByRole('menu', { name: 'Selection actions' });
  const highlightItem = page.getByRole('menuitem', { name: 'Highlight', exact: true });
  const bookmarkItem = page.getByRole('menuitem', { name: 'Bookmark here' });
  const copyItem = page.getByRole('menuitem', { name: 'Copy' });

  // No menu until a contextmenu fires over a live selection.
  await expect(menu).toHaveCount(0);
  await openContextMenu(page);
  await expect(menu).toBeVisible();
  await expect(highlightItem).toBeVisible();
  await expect(bookmarkItem).toBeVisible();
  await expect(copyItem).toBeVisible();

  // The first item takes focus; arrows move between items.
  await expect(highlightItem).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(bookmarkItem).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(highlightItem).toBeFocused();

  // Escape dismisses it.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // An outside click dismisses it (and, like any click, clears the selection).
  await openContextMenu(page);
  await expect(menu).toBeVisible();
  await page.locator('.reader-toolbar h2').click();
  await expect(menu).toHaveCount(0);

  // Re-select, reopen, and choose Highlight: it stores a highlight and closes.
  await selectPageText(page);
  await expect(highlightReady).toBeEnabled();
  await openContextMenu(page);
  await expect(menu).toBeVisible();
  await highlightItem.click();
  await expect(menu).toHaveCount(0);
  await expect(notesPanel.locator('.reader-bookmark-list li')).toHaveCount(1);
  await expect(notesPanel.locator('.reader-annotation-kind')).toHaveText('Highlight');
});
