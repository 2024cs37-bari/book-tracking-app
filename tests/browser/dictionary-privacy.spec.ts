import { expect, test } from '@playwright/test';
import { buildPdfFixture } from '../support/fixtures';
import { importBook } from './support';

// Browser routing cannot intercept requests owned by an installed service worker.
// This consent/CSP test must use the controlled response in every engine.
test.use({ serviceWorkers: 'block' });

test('dictionary requires opt-in and its configured origin is allowed by app CSP', async ({
  page,
}) => {
  let lookups = 0;
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('violates') && message.text().includes('connect-src'))
      violations.push(message.text());
  });
  await page.route('https://api.dictionaryapi.dev/api/v2/entries/en/*', async (route) => {
    lookups++;
    await route.fulfill({
      json: [
        {
          word: 'generated',
          meanings: [
            { partOfSpeech: 'verb', definitions: [{ definition: 'Created for this local test.' }] },
          ],
        },
      ],
    });
  });
  await importBook(
    page,
    buildPdfFixture({ title: 'Dictionary Privacy', pageCount: 1 }),
    'dictionary.pdf',
    'Dictionary Privacy',
  );
  await expect(page.locator('.pdf-page .textLayer')).toContainText('Generated page 1');
  await page.getByRole('tab', { name: 'Notes' }).click();
  await page.evaluate(() => {
    const layer = document.querySelector('.pdf-page .textLayer')!;
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent?.includes('Generated')) node = walker.nextNode();
    if (!node) throw new Error('Generated text missing');
    const range = document.createRange();
    const start = node.textContent!.indexOf('Generated');
    range.setStart(node, start);
    range.setEnd(node, start + 'Generated'.length);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.getByRole('button', { name: 'Highlight selection' })).toBeEnabled();
  await page.locator('.pdf-page .textLayer').dispatchEvent('contextmenu', { bubbles: true });
  await page.getByRole('menuitem', { name: /^Define/ }).click();
  await expect(page.getByRole('button', { name: 'Allow dictionary lookups' })).toBeVisible();
  expect(lookups).toBe(0);
  await page.getByRole('button', { name: 'Allow dictionary lookups' }).click();
  await expect(page.getByText('Created for this local test.')).toBeVisible();
  expect(lookups).toBe(1);
  expect(violations).toEqual([]);
  await page.goto('/settings');
  await page.getByRole('checkbox', { name: 'Allow online dictionary lookups' }).uncheck();
  await page.reload();
  await expect(
    page.getByRole('checkbox', { name: 'Allow online dictionary lookups' }),
  ).not.toBeChecked();
});
