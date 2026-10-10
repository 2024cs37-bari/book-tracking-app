import { expect, test } from '@playwright/test';
import { buildEpubFixture } from '../support/fixtures';
import { importBook } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('a book page lists its notes and exports them', async ({ page }) => {
  await importBook(
    page,
    buildEpubFixture({ title: 'Reviewed Book', chapters: 1, paragraphs: 8 }),
    'reviewed.epub',
    'Reviewed Book',
  );

  // Make an annotation in the reader, then return to the book page.
  await page.locator('.reader-bookmarks summary').click();
  await page.getByRole('button', { name: 'Bookmark this position' }).click();
  await expect(page.locator('.reader-bookmark-list li')).toHaveCount(1);
  await page.getByRole('link', { name: '← Close reader' }).click();

  const review = page.locator('.annotations-review');
  await expect(review.getByRole('heading', { name: 'Notes & highlights' })).toBeVisible();
  await expect(review.locator('.annotation-review-row')).toHaveCount(1);
  await expect(review.locator('.reader-annotation-kind')).toHaveText('Bookmark');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    review.getByRole('button', { name: 'Export notes as Markdown' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('notes-reviewed-book.md');
});
