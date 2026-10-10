import { expect, test } from '@playwright/test';
import { buildEpubFixture, buildPdfFixture } from '../support/fixtures';
import { importStoredBook } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('importing a PDF generates and displays a cover thumbnail', async ({ page }) => {
  await importStoredBook(
    page,
    buildPdfFixture({ title: 'Cover PDF', pageCount: 2 }),
    'cover.pdf',
    'Cover PDF',
  );
  // A PDF carries no embedded cover, so the import pipeline rasterizes page one.
  const cover = page.locator('.details-card .cover img');
  await expect(cover).toBeVisible();
  await expect
    .poll(() => cover.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
});

test('library status filter, archived shelf and soft-delete exclusion', async ({ page }) => {
  await importStoredBook(
    page,
    buildPdfFixture({ title: 'Alpha Active', pageCount: 2 }),
    'alpha.pdf',
    'Alpha Active',
  );
  await page.locator('#reading-status').selectOption('reading');
  await expect(page.locator('#reading-status')).toHaveValue('reading');

  await importStoredBook(
    page,
    buildEpubFixture({ title: 'Beta Archived' }),
    'beta.epub',
    'Beta Archived',
  );
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore to library' })).toBeVisible();

  await importStoredBook(
    page,
    buildEpubFixture({ title: 'Gamma Deleted' }),
    'gamma.epub',
    'Gamma Deleted',
  );
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Mark as deleted' }).click();
  // Deleting navigates back to the library.
  await expect(page.locator('.library-toolbar')).toBeVisible();

  const alpha = page.getByRole('link', { name: /Alpha Active/ });
  const beta = page.getByRole('link', { name: /Beta Archived/ });
  const gamma = page.getByRole('link', { name: /Gamma Deleted/ });

  const setView = (value: string) => page.locator('#library-lifecycle').selectOption(value);
  const setStatus = (value: string) => page.locator('#library-status').selectOption(value);

  // The active view shows only the active book; archived and deleted are excluded.
  await setView('active');
  await setStatus('all');
  await expect(alpha).toBeVisible();
  await expect(beta).toHaveCount(0);
  await expect(gamma).toHaveCount(0);

  // Reading-status filter narrows within the active view.
  await setStatus('reading');
  await expect(alpha).toBeVisible();
  await setStatus('finished');
  await expect(alpha).toHaveCount(0);

  // Archived view shows only the archived book.
  await setStatus('all');
  await setView('archived');
  await expect(beta).toBeVisible();
  await expect(alpha).toHaveCount(0);
  await expect(gamma).toHaveCount(0);

  // "All" is active + archived, never the soft-deleted book.
  await setView('all');
  await expect(alpha).toBeVisible();
  await expect(beta).toBeVisible();
  await expect(gamma).toHaveCount(0);
});
