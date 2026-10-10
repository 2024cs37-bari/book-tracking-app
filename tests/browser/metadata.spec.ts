import { expect, test } from '@playwright/test';
import { buildEpubFixture } from '../support/fixtures';
import { importStoredBook } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('editing book metadata persists across a reload', async ({ page }) => {
  await importStoredBook(
    page,
    buildEpubFixture({ title: 'Original Title', creator: 'Old Author', publisher: 'Old House' }),
    'editable.epub',
    'Original Title',
  );

  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await page.locator('#edit-title').fill('Edited Title');
  await page.locator('#edit-author').fill('New Author');
  await page.locator('#edit-publisher').fill('New House');
  await page.locator('#edit-pages').fill('123');
  await page.getByRole('button', { name: 'Save details', exact: true }).click();

  await expect(page.getByText('Book details updated.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Edited Title' })).toBeVisible();
  const details = page.locator('.details-list');
  await expect(details).toContainText('New Author');
  await expect(details).toContainText('New House');
  await expect(details).toContainText('123');

  // The edit is written to IndexedDB, so it survives a reload.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Edited Title' })).toBeVisible();
  await expect(page.locator('.details-list')).toContainText('New Author');
  await expect(page.locator('.details-list')).toContainText('New House');
  await expect(page.locator('.details-list')).toContainText('123');
});

test('rejects an empty title in the edit form without persisting', async ({ page }) => {
  await importStoredBook(
    page,
    buildEpubFixture({ title: 'Keep Title', creator: 'Author' }),
    'keep.epub',
    'Keep Title',
  );
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await page.locator('#edit-title').fill('   ');
  await page.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/title must not be empty/i);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Keep Title' })).toBeVisible();
});
