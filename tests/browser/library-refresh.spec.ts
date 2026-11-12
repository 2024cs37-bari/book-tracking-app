import { expect, test } from '@playwright/test';
import { buildPdfFixture } from '../support/fixtures';
import { importStoredBook } from './support';

test('incoming library refresh preserves an existing card through pointer down and click', async ({
  page,
  context,
}) => {
  await importStoredBook(
    page,
    buildPdfFixture({ title: 'A stable book', pageCount: 2 }),
    'stable.pdf',
    'A stable book',
  );
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  const otherTab = await context.newPage();
  await otherTab.goto('/');
  await expect(otherTab.getByRole('button', { name: 'Add books', exact: true })).toBeVisible();
  await page.bringToFront();
  const link = page.getByRole('link', { name: /^A stable book/ });
  await expect(link).toBeVisible();
  const original = await link.elementHandle();
  const box = await link.boundingBox();
  if (!original || !box) throw new Error('Book card unavailable');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();

  // An import in another tab publishes a commit while the user holds a card.
  // The current tab gets the repository event without showing an import-result
  // banner, whose legitimate layout shift would move the pointer off the card.
  await otherTab.locator('#library-import').setInputFiles({
    name: 'second.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(buildPdfFixture({ title: 'Z incoming book', pageCount: 2 })),
  });
  await expect(page.getByRole('link', { name: /^Z incoming book/ })).toBeVisible();
  expect(await original.evaluate((element) => element.isConnected)).toBe(true);
  await page.mouse.up();
  await expect(page.getByRole('heading', { name: 'A stable book', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read', exact: true })).toBeEnabled();
});
