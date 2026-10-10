import { expect, test } from '@playwright/test';
import { buildEpubFixture } from '../support/fixtures';
import { importBook } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('the reader sidebar toggles, switches panels, and persists', async ({ page }) => {
  await importBook(
    page,
    buildEpubFixture({ title: 'Sidebar Book', chapters: 3, paragraphs: 10 }),
    'sidebar.epub',
    'Sidebar Book',
  );

  const sidebar = page.locator('.reader-sidebar');
  const toggle = page.getByRole('button', { name: 'Toggle sidebar' });

  // Open by default.
  await expect(sidebar).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // The toggle button collapses it.
  await toggle.click();
  await expect(sidebar).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // The 's' key reopens it from the reader chrome (not while typing).
  await page.getByRole('link', { name: '← Close reader' }).focus();
  await page.keyboard.press('s');
  await expect(sidebar).toBeVisible();

  // The Pages panel lists EPUB sections (reflowable, so no thumbnails).
  await page.getByRole('tab', { name: 'Pages' }).click();
  await expect(sidebar.locator('.reader-pages-list')).toBeVisible();

  // The Contents panel shows the book navigation.
  await page.getByRole('tab', { name: 'Contents' }).click();
  await expect(sidebar.getByRole('navigation', { name: 'Book contents' })).toBeVisible();

  // Open state persists across a reload.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await expect(page.locator('.reader-sidebar')).toBeVisible();
});
