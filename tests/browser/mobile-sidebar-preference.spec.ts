import { expect, test } from '@playwright/test';
import { buildPdfFixture } from '../support/fixtures';
import { importStoredBook } from './support';

test('a saved desktop sidebar does not cover the book when opening or rotating a phone reader', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await importStoredBook(
    page,
    buildPdfFixture({ title: 'Saved desktop sidebar', pageCount: 3 }),
    'saved-sidebar.pdf',
    'Saved desktop sidebar',
  );
  await page.evaluate(() =>
    localStorage.setItem(
      'reader-sidebar',
      JSON.stringify({ open: true, panel: 'contents', width: 300 }),
    ),
  );
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  const toggle = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.reader-sidebar')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('reader-sidebar')!).open)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.reader-scrim')).toHaveCount(0);
});
