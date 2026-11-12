import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { buildEpubFixture } from '../support/fixtures';
import { chooseSelect, importStoredBook } from './support';

test('pins persist and original export preserves bytes', async ({ page }, testInfo) => {
  const bytes = buildEpubFixture({ title: 'Offline Original' });
  await importStoredBook(page, bytes, 'offline.epub', 'Offline Original');
  await page.getByRole('button', { name: 'Pin for offline reading' }).click();
  await expect(page.getByRole('button', { name: 'Unpin offline copy' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Unpin offline copy' })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save original file' }).click();
  const download = await pending;
  const output = testInfo.outputPath('original.epub');
  await download.saveAs(output);
  expect(await readFile(output)).toEqual(Buffer.from(bytes));
});

test('portable backup restores verified originals into a clean browser', async ({
  page,
  browser,
}, testInfo) => {
  const title = 'Portable Recovery';
  await importStoredBook(page, buildEpubFixture({ title }), 'portable.epub', title);
  await chooseSelect(page.locator('#reading-status'), 'reading');
  // The selector is disabled until the status transaction and repository read
  // complete. A hard page.goto here can abort the pending IndexedDB write.
  await expect(page.locator('#reading-status')).toBeEnabled();
  await expect(page.locator('#reading-status')).toHaveAttribute('data-value', 'reading');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download portable backup' }).click();
  const archive = testInfo.outputPath('backup.zip');
  await (await pending).saveAs(archive);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const restored = await context.newPage();
    await restored.goto('/settings');
    await restored.getByLabel('Select a backup file').setInputFiles(archive);
    await expect(restored.getByRole('heading', { name: /Review recovery/ })).toBeVisible();
    await restored.getByRole('button', { name: 'Add missing data from backup' }).click();
    await expect(
      restored.getByRole('status').filter({ hasText: /Recovered 1 books/ }),
    ).toBeVisible();
    await restored.goto('/');
    await restored.getByRole('link', { name: new RegExp(title) }).click();
    await expect(restored.locator('#reading-status')).toHaveAttribute('data-value', 'reading');
    await restored.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(restored.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  } finally {
    await context.close();
  }
});
