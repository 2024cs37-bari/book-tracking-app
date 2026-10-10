import { expect, test } from '@playwright/test';
import { buildEpubFixture } from '../support/fixtures';
import { importBook } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('exports the book notes as a downloadable Markdown file', async ({ page }) => {
  await importBook(
    page,
    buildEpubFixture({ title: 'Notes Export', chapters: 1, paragraphs: 8 }),
    'notes.epub',
    'Notes Export',
  );

  const panel = page.locator('.reader-bookmarks');
  await page.getByRole('tab', { name: 'Notes' }).click();

  // Nothing to export until there is at least one annotation.
  const exportButton = page.getByRole('button', { name: 'Export notes' });
  await expect(exportButton).toBeDisabled();

  await page.getByRole('button', { name: 'Bookmark this position' }).click();
  await expect(panel.locator('.reader-bookmark-list li')).toHaveCount(1);
  await expect(exportButton).toBeEnabled();

  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  expect(download.suggestedFilename()).toBe('notes-notes-export.md');

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const markdown = Buffer.concat(chunks).toString('utf8');

  expect(markdown).toContain('# Notes Export');
  expect(markdown).toContain('annotation, exported');
  expect(markdown).toContain('### Bookmark');
});
