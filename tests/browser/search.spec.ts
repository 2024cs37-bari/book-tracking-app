import { expect, test, type Page } from '@playwright/test';
import { buildEpubFixture, buildPdfFixture } from '../support/fixtures';
import { importBook } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

async function openSearch(page: Page, query: string): Promise<void> {
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByLabel('Search in book', { exact: true }).fill(query);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
}

test('EPUB in-book search returns flattened excerpts and navigates on click', async ({ page }) => {
  await importBook(
    page,
    buildEpubFixture({ title: 'Searchable EPUB', chapters: 2, paragraphs: 20 }),
    'search.epub',
    'Searchable EPUB',
  );

  // The real foliate-js search runs here (the jsdom test cannot drive the
  // paginator). A non-empty excerpt containing the phrase proves the
  // `{ pre, match, post }` flattening works end to end in a real browser.
  await openSearch(page, 'Chapter 2 paragraph 1');
  const firstHit = page.locator('.reader-search-hit').first();
  await expect(firstHit).toBeVisible();
  await expect(firstHit.locator('.reader-search-excerpt')).toContainText(/chapter 2 paragraph 1/i);
  await expect(firstHit.locator('.reader-search-excerpt')).not.toHaveText('');

  // Clicking a chapter-2 hit from chapter 1 moves the reading position forward.
  const percent = async () =>
    Number(
      (await page.getByLabel('Reading progress', { exact: true }).textContent())!.replace(
        /\D/g,
        '',
      ),
    );
  await firstHit.click();
  await expect.poll(percent).toBeGreaterThan(5);
});

test('PDF in-book search navigates to the matching page on click', async ({ page }) => {
  await importBook(
    page,
    buildPdfFixture({ title: 'Searchable PDF', pageCount: 12 }),
    'search.pdf',
    'Searchable PDF',
  );
  const canvas = page.locator('.pdf-scroll canvas[data-render-state="ready"]');
  await expect(canvas).toHaveAttribute('aria-label', 'Page 1 of 12');

  // Each page's text is "Generated page N"; "Generated page 9" is unique to page 9.
  await openSearch(page, 'Generated page 9');
  const hits = page.locator('.reader-search-hit');
  await expect(hits).toHaveCount(1);
  await expect(hits.first().locator('.reader-search-excerpt')).toContainText(/generated page 9/i);

  await hits.first().click();
  await expect(canvas).toHaveAttribute('aria-label', 'Page 9 of 12');
});

test('a blank in-book search reports no matches', async ({ page }) => {
  await importBook(
    page,
    buildPdfFixture({ title: 'No Match PDF', pageCount: 3 }),
    'nomatch.pdf',
    'No Match PDF',
  );
  await openSearch(page, 'zzzznonexistentzzz');
  await expect(page.getByText(/No matches for/)).toBeVisible();
  await expect(page.locator('.reader-search-hit')).toHaveCount(0);
});
