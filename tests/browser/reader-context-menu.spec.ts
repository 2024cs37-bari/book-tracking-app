import { expect, test, type Frame, type Page } from '@playwright/test';
import { buildEpubFixture, buildPdfFixture } from '../support/fixtures';
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

test('a selection context menu offers highlight colours, Bookmark, and Copy', async ({ page }) => {
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
  const notesPanel = page.locator('.reader-notes-panel');
  const highlightReady = page.getByRole('button', { name: 'Highlight selection' });
  await expect(highlightReady).toBeDisabled();

  await selectPageText(page);
  await expect(highlightReady).toBeEnabled();

  const menu = page.getByRole('menu', { name: 'Selection actions' });
  const yellowSwatch = page.getByRole('menuitem', { name: 'Highlight Yellow' });
  const greenSwatch = page.getByRole('menuitem', { name: 'Highlight Green' });
  const bookmarkItem = page.getByRole('menuitem', { name: 'Bookmark here' });
  const copyItem = page.getByRole('menuitem', { name: 'Copy' });

  // No menu until a contextmenu fires over a live selection.
  await expect(menu).toHaveCount(0);
  await openContextMenu(page);
  await expect(menu).toBeVisible();
  await expect(yellowSwatch).toBeVisible();
  await expect(greenSwatch).toBeVisible();
  await expect(bookmarkItem).toBeVisible();
  await expect(copyItem).toBeVisible();

  // The first colour swatch takes focus; arrows move between items.
  await expect(yellowSwatch).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(greenSwatch).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(yellowSwatch).toBeFocused();

  // Escape dismisses it.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // An outside click dismisses it (and, like any click, clears the selection).
  await openContextMenu(page);
  await expect(menu).toBeVisible();
  await page.locator('.reader-toolbar h2').click();
  await expect(menu).toHaveCount(0);

  // Re-select, reopen, and choose a colour: it stores a highlight and closes.
  await selectPageText(page);
  await expect(highlightReady).toBeEnabled();
  await openContextMenu(page);
  await expect(menu).toBeVisible();
  await yellowSwatch.click();
  await expect(menu).toHaveCount(0);
  await expect(notesPanel.locator('.reader-annotation-list li')).toHaveCount(1);
  await expect(notesPanel.locator('.reader-annotation-kind')).toHaveText('Highlight');
});

/** The live foliate book frame (its document is a blob: URL). */
async function bookFrame(page: Page): Promise<Frame> {
  await expect
    .poll(() => page.frames().filter((frame) => frame.url().startsWith('blob:')).length)
    .toBeGreaterThan(0);
  return page.frames().find((frame) => frame.url().startsWith('blob:'))!;
}

/** Selects the first paragraph (or just its first word) inside the book frame. */
async function selectInFrame(frame: Frame, singleWord: boolean): Promise<void> {
  await frame.evaluate((single) => {
    const paragraph = document.querySelector('p');
    if (!paragraph) throw new Error('No paragraph to select');
    const selection = document.getSelection();
    if (!selection) throw new Error('No selection API');
    const range = document.createRange();
    if (single) {
      const node = paragraph.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error('No text node');
      const text = node.textContent ?? '';
      const space = text.indexOf(' ');
      range.setStart(node, 0);
      range.setEnd(node, space === -1 ? text.length : Math.max(1, space));
    } else {
      range.selectNodeContents(paragraph);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, singleWord);
}

/** Fires a bubbling contextmenu from inside the book frame, as a right click would. */
async function contextMenuInFrame(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const paragraph = document.querySelector('p');
    if (!paragraph) throw new Error('No paragraph for context menu');
    const rect = paragraph.getBoundingClientRect();
    paragraph.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(rect.left + 5),
        clientY: Math.round(rect.top + 5),
      }),
    );
  });
}

test('the context menu reaches an EPUB selection inside the book frame', async ({ page }) => {
  await importBook(
    page,
    buildEpubFixture({ title: 'Context Menu EPUB', chapters: 1, paragraphs: 6 }),
    'context-menu.epub',
    'Context Menu EPUB',
  );

  await page.getByRole('tab', { name: 'Notes' }).click();
  const notesPanel = page.locator('.reader-notes-panel');
  const highlightReady = page.getByRole('button', { name: 'Highlight selection' });
  await expect(highlightReady).toBeDisabled();

  const frame = await bookFrame(page);
  await selectInFrame(frame, false);
  await expect(highlightReady).toBeEnabled();

  const menu = page.getByRole('menu', { name: 'Selection actions' });
  await expect(menu).toHaveCount(0);
  await contextMenuInFrame(frame);
  await expect(menu).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Highlight Yellow' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Bookmark here' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Copy' })).toBeVisible();

  // Choosing a swatch highlights the EPUB selection and closes the menu.
  await page.getByRole('menuitem', { name: 'Highlight Yellow' }).click();
  await expect(menu).toHaveCount(0);
  await expect(notesPanel.locator('.reader-annotation-list li')).toHaveCount(1);
  await expect(notesPanel.locator('.reader-annotation-kind')).toHaveText('Highlight');
});

test('a single-word EPUB selection offers a Define action', async ({ page }) => {
  await importBook(
    page,
    buildEpubFixture({ title: 'Define EPUB', chapters: 1, paragraphs: 6 }),
    'define.epub',
    'Define EPUB',
  );

  await page.getByRole('tab', { name: 'Notes' }).click();
  const highlightReady = page.getByRole('button', { name: 'Highlight selection' });
  const frame = await bookFrame(page);
  await selectInFrame(frame, true);
  await expect(highlightReady).toBeEnabled();

  const menu = page.getByRole('menu', { name: 'Selection actions' });
  await contextMenuInFrame(frame);
  await expect(menu).toBeVisible();
  // The dictionary lookup itself needs the network and is not exercised here;
  // we only assert the single-word action is offered.
  await expect(page.getByRole('menuitem', { name: /^Define/ })).toBeVisible();
});
