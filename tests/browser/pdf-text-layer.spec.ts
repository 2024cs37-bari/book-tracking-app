import { expect, test } from '@playwright/test';
import { buildPdfFixture } from '../support/fixtures';
import { importBook } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('a PDF page renders a selectable text layer over the canvas', async ({ page }) => {
  await importBook(
    page,
    buildPdfFixture({ title: 'Text Layer PDF', pageCount: 3 }),
    'textlayer.pdf',
    'Text Layer PDF',
  );

  // The bounded single canvas is unchanged...
  await expect(page.locator('.pdf-scroll canvas[data-render-state="ready"]')).toHaveCount(1);

  // ...and a transparent text layer now carries the page's selectable text.
  const textLayer = page.locator('.pdf-page .textLayer');
  await expect.poll(() => textLayer.locator('span').count()).toBeGreaterThan(0);
  await expect(textLayer).toContainText('Generated page 1');

  // The text is genuinely selectable through the layer.
  const selected = await textLayer.evaluate((layer) => {
    const range = document.createRange();
    range.selectNodeContents(layer);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  expect(selected).toContain('Generated page 1');
});
