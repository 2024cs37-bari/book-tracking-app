import { expect, test } from '@playwright/test';
import { buildEpubFixture, buildPdfFixture } from '../support/fixtures';
import { importBook, position } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('arrow keys turn PDF pages from the reader chrome, but not while typing', async ({ page }) => {
  await importBook(
    page,
    buildPdfFixture({ title: 'Keyboard PDF', pageCount: 3 }),
    'keyboard.pdf',
    'Keyboard PDF',
  );
  const canvas = page.locator('.pdf-scroll canvas[data-render-state="ready"]');
  await expect(canvas).toHaveAttribute('aria-label', 'Page 1 of 3');

  // Focus the reader chrome (not the page surface) so the shell handles the key.
  await page.getByRole('link', { name: '← Close reader' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(canvas).toHaveAttribute('aria-label', 'Page 2 of 3');
  await page.keyboard.press('ArrowLeft');
  await expect(canvas).toHaveAttribute('aria-label', 'Page 1 of 3');

  // Keys are ignored while a text field has focus, so searching is unaffected.
  await page.getByRole('tab', { name: 'Search' }).click();
  const search = page.getByRole('searchbox', { name: 'Search in book' });
  await search.focus();
  await page.keyboard.press('ArrowRight');
  await expect(canvas).toHaveAttribute('aria-label', 'Page 1 of 3');
});

test('arrow keys advance an EPUB from the reader chrome', async ({ page }) => {
  await importBook(
    page,
    buildEpubFixture({ title: 'Keyboard EPUB', chapters: 2, paragraphs: 40 }),
    'keyboard.epub',
    'Keyboard EPUB',
  );
  await page.getByRole('link', { name: '← Close reader' }).focus();
  for (let turn = 0; turn < 4; turn += 1) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
  }
  await expect.poll(async () => (await position(page)).fraction).toBeGreaterThan(0.01);
});
