import { expect, test } from '@playwright/test';
import { buildPdfFixture } from '../support/fixtures';
import { importBook } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('PDF outline renders a nested table of contents and navigates on selection', async ({
  page,
}) => {
  await importBook(
    page,
    buildPdfFixture({
      title: 'Outlined PDF',
      pageCount: 8,
      outline: [
        { title: 'Cover', page: 0 },
        {
          title: 'Part One',
          page: 2,
          children: [
            { title: 'Section A', page: 3 },
            { title: 'Section B', page: 4 },
          ],
        },
        { title: 'Conclusion', page: 7 },
      ],
    }),
    'outline.pdf',
    'Outlined PDF',
  );
  const canvas = page.locator('.pdf-scroll canvas[data-render-state="ready"]');
  await expect(canvas).toHaveAttribute('aria-label', 'Page 1 of 8');

  await page.getByText('Table of contents', { exact: true }).click();
  const contents = page.getByRole('navigation', { name: 'Book contents' });
  await expect(contents.getByRole('button', { name: 'Cover', exact: true })).toBeVisible();
  await expect(contents.getByRole('button', { name: 'Part One', exact: true })).toBeVisible();
  // The nested chapter forms a second-level list.
  await expect(contents.locator('ol ol')).toHaveCount(1);
  await expect(contents.getByRole('button', { name: 'Section A', exact: true })).toBeVisible();

  await contents.getByRole('button', { name: 'Conclusion', exact: true }).click();
  // "Conclusion" targets page index 7, i.e. page 8 of 8.
  await expect(canvas).toHaveAttribute('aria-label', 'Page 8 of 8');
});
