import { expect, test } from '@playwright/test';
import { buildEpubFixture, buildPdfFixture } from '../support/fixtures';
import { chooseSelect, importStoredBook } from './support';

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

test('library format/status filters, archived shelf and soft-delete exclusion', async ({
  page,
  context,
}) => {
  await importStoredBook(
    page,
    buildPdfFixture({ title: 'Alpha Active', pageCount: 2 }),
    'alpha.pdf',
    'Alpha Active',
  );
  await chooseSelect(page.locator('#reading-status'), 'reading');
  await expect(page.locator('#reading-status')).toBeEnabled();
  await expect(page.locator('#reading-status')).toHaveAttribute('data-value', 'reading');

  await importStoredBook(
    page,
    buildEpubFixture({ title: 'Beta Archived' }),
    'beta.epub',
    'Beta Archived',
  );
  await page.getByText('Manage book', { exact: true }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore to library' })).toBeVisible();

  await importStoredBook(
    page,
    buildEpubFixture({ title: 'Gamma Deleted' }),
    'gamma.epub',
    'Gamma Deleted',
  );
  await page.getByText('Manage book', { exact: true }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Mark as deleted' }).click();
  // Deleting navigates back to the library.
  await expect(page.locator('.library-toolbar')).toBeVisible();

  const alpha = page.getByRole('link', { name: /Alpha Active/ });
  const beta = page.getByRole('link', { name: /Beta Archived/ });
  const gamma = page.getByRole('link', { name: /Gamma Deleted/ });

  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const setView = (value: string) => chooseSelect(page.locator('#library-lifecycle'), value);
  const setStatus = (value: string) => chooseSelect(page.locator('#library-status'), value);

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

  // Format composes with the other filters and requires no network.
  await context.setOffline(true);
  await chooseSelect(page.getByRole('combobox', { name: 'Format', exact: true }), 'epub');
  await expect(beta).toBeVisible();
  await expect(alpha).toHaveCount(0);
  await setStatus('reading');
  await expect(beta).toHaveCount(0);
  await chooseSelect(page.getByRole('combobox', { name: 'Format', exact: true }), 'pdf');
  await expect(alpha).toBeVisible();
  await expect(beta).toHaveCount(0);
  await chooseSelect(page.getByRole('combobox', { name: 'Format', exact: true }), 'all');
  await setStatus('all');
  await expect(alpha).toBeVisible();
  await expect(beta).toBeVisible();
  await expect(gamma).toHaveCount(0);
});

test('rename a tag offline, reject a duplicate name, and retain book membership after reload', async ({
  page,
  context,
}) => {
  await importStoredBook(
    page,
    buildEpubFixture({ title: 'Tagged Book' }),
    'tagged.epub',
    'Tagged Book',
  );
  await page.getByRole('textbox', { name: 'New tag', exact: true }).fill('Research');
  await page.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Remove tag Research', exact: true }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'New tag', exact: true }).fill('Reference');
  await page.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Remove tag Reference', exact: true }),
  ).toBeVisible();
  await page.locator('.app-nav').getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Rename tag Research', exact: true }).click();
  await expect(page.getByLabel('New tag name')).toBeFocused();
  await context.setOffline(true);
  await page.getByLabel('New tag name').fill(' REFERENCE ');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Another tag already uses this name');
  await expect(
    page.getByRole('button', { name: 'Rename tag Research', exact: true }),
  ).toBeVisible();
  await page.getByLabel('New tag name').fill('Reading Notes');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Rename tag Reading Notes', exact: true }),
  ).toBeVisible();
  // Restore transport only to permit reload in engines where the SW is still activating.
  await context.setOffline(false);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Rename tag Reading Notes', exact: true }),
  ).toBeVisible();
  await page.locator('.app-nav').getByRole('link', { name: 'Library' }).click();
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await chooseSelect(page.getByRole('combobox', { name: 'Tag', exact: true }), {
    label: 'Reading Notes',
  });
  await page.getByRole('link', { name: /Tagged Book/ }).click();
  await expect(
    page.getByRole('button', { name: 'Remove tag Reading Notes', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove tag Research', exact: true })).toHaveCount(
    0,
  );
});

test('quiet library controls preserve filters, keyboard focus and an easy reset', async ({
  page,
}) => {
  await importStoredBook(
    page,
    buildEpubFixture({ title: 'A book to find' }),
    'find.epub',
    'A book to find',
  );
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  const filters = page.getByRole('button', { name: /^Filters/ });
  const panel = page.locator('#library-filters');
  await expect(panel).toBeHidden();
  await filters.focus();
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  await expect(filters).toHaveAttribute('aria-expanded', 'true');
  await chooseSelect(page.getByRole('combobox', { name: 'Format', exact: true }), 'pdf');
  await expect(page.getByRole('heading', { name: 'No matching books' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Format', exact: true }).press('Escape');
  await expect(panel).toBeHidden();
  await expect(filters).toBeFocused();
  await expect(filters).toHaveText('Filters1');
  await filters.click();
  await expect(page.getByRole('combobox', { name: 'Format', exact: true })).toHaveAttribute(
    'data-value',
    'pdf',
  );
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await expect(page.getByRole('link', { name: /^A book to find/ })).toBeVisible();
  await filters.click();
  await page.getByRole('button', { name: 'Finished', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No matching books' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search and filters' }).click();
  await expect(page.getByRole('button', { name: 'All books', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('no such title');
  await page.getByRole('button', { name: 'Clear search and filters' }).click();
  await expect(page.getByRole('searchbox', { name: 'Search', exact: true })).toHaveValue('');
  await expect(page.getByRole('link', { name: /^A book to find/ })).toBeVisible();
});
