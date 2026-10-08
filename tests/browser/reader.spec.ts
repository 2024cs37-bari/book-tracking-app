import { expect, test, type Page } from '@playwright/test';
import { buildEpubFixture, buildPdfFixture } from '../support/fixtures';
import { importBook, position } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('requestfailed', (request) =>
    console.error('Request failed:', request.url(), request.failure()),
  );
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('hostile EPUB renders, saves CFI, and resumes after an offline reload', async ({
  page,
  context,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('script-src')) violations.push(message.text());
  });
  await importBook(
    page,
    buildEpubFixture({ title: 'Reader EPUB', chapters: 3, paragraphs: 60, hostileScript: true }),
    'reader.epub',
    'Reader EPUB',
  );
  // Closed upstream shadow roots are inspected through Playwright's frame list.
  await expect
    .poll(() => page.frames().filter((frame) => frame.url().startsWith('blob:')).length)
    .toBeGreaterThan(0);
  const frame = page.frames().find((frame) => frame.url().startsWith('blob:'))!;
  await expect(frame.locator('body')).toContainText('Generated reader content');
  expect(await frame.evaluate(() => 'bookScriptExecuted' in globalThis)).toBe(false);
  expect(await page.evaluate(() => 'bookScriptExecuted' in globalThis)).toBe(false);
  expect(violations.length).toBeGreaterThan(0);
  for (let index = 0; index < 4; index++) {
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.waitForTimeout(150);
  }
  await expect.poll(async () => (await position(page)).fraction).toBeGreaterThan(0.01);
  const initialSave = await position(page);
  expect(initialSave.locatorKind).toBe('cfi');
  expect(initialSave.locatorValue).toMatch(/^epubcfi\(/);
  await page.getByText('Reader settings', { exact: true }).click();
  await page.getByLabel('Theme', { exact: true }).selectOption('sepia');
  await page.getByRole('link', { name: '← Close reader' }).click();
  const saved = await position(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  const url = page.url();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  expect(page.url()).toBe(url);
  await expect
    .poll(async () => Math.abs((await position(page)).fraction - saved.fraction))
    .toBeLessThan(0.03);
  await expect(page.getByLabel('Reading progress', { exact: true })).toHaveText(
    `${Math.round(saved.fraction * 100)}%`,
  );
  await page.getByText('Reader settings', { exact: true }).click();
  await expect(page.getByLabel('Theme', { exact: true })).toHaveValue('sepia');
});

for (const version of ['2.0', '3.0'] as const) {
  test(`EPUB ${version} navigation and RTL generated content opens`, async ({ page }) => {
    await importBook(
      page,
      buildEpubFixture({
        title: `EPUB ${version}`,
        epubVersion: version,
        rtl: true,
        chapters: 2,
        paragraphs: 20,
      }),
      'version.epub',
      `EPUB ${version}`,
    );
    const frame = page.frames().find((frame) => frame.url().startsWith('blob:'))!;
    await expect(frame.locator('body')).toHaveAttribute('dir', 'rtl');
    await expect(frame.locator('body')).toContainText('Chapter 1');
  });
}

test('PDF uses one bounded visible canvas, handles varied/rotated pages and restores vertical offset offline', async ({
  page,
  context,
}) => {
  await importBook(
    page,
    buildPdfFixture({ title: 'Reader PDF', pageCount: 30, variedPages: true }),
    'reader.pdf',
    'Reader PDF',
  );
  const canvas = page.locator('.pdf-scroll canvas[data-render-state="ready"]');
  await expect(canvas).toHaveAttribute('aria-label', 'Page 1 of 30');
  await page.getByText('Table of contents', { exact: true }).click();
  await expect(page.getByText('No table of contents available.', { exact: true })).toBeVisible();
  await page.getByText('Table of contents', { exact: true }).click();
  // Ensure actual text pixels were painted, not just a blank allocated canvas.
  expect(
    await canvas.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      return Array.from(pixels).some((value, index) => index % 4 !== 3 && value < 100);
    }),
  ).toBe(true);
  for (let index = 1; index <= 8; index++) {
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(canvas).toHaveAttribute('aria-label', `Page ${index + 1} of 30`);
    await expect(canvas).toHaveCount(1);
    expect(
      await canvas.evaluate(
        (element) => (element as HTMLCanvasElement).width * (element as HTMLCanvasElement).height,
      ),
    ).toBeLessThanOrEqual(4_000_000);
  }
  await page.locator('.pdf-scroll').evaluate((element) => {
    element.scrollTop = 100;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(async () => (await position(page)).locatorValue).toMatch(/^8:[1-9]/);
  const saved = await position(page);
  const readerUrl = page.url();
  await page.getByRole('link', { name: '← Close reader' }).click();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.goto(readerUrl);
  await expect(canvas).toHaveAttribute('aria-label', 'Page 9 of 30');
  await expect.poll(async () => (await position(page)).locatorValue).toBe(saved.locatorValue);
});

async function targetParagraphVisible(page: Page): Promise<boolean> {
  // The engine's public relocation range describes the actual visible page;
  // merely finding paragraph text in a loaded chapter would be a false positive.
  return page.evaluate(() => {
    const view = document.querySelector('foliate-view') as HTMLElement & {
      lastLocation?: { range?: Range };
    };
    const range = view?.lastLocation?.range;
    const paragraph = range?.startContainer.ownerDocument?.getElementById('paragraph-40');
    return !!paragraph && !!range?.intersectsNode(paragraph);
  });
}

for (const version of ['2.0', '3.0'] as const) {
  test(`EPUB ${version} nested contents uses keyboard navigation and resumes the fragment offline`, async ({
    page,
    context,
  }) => {
    await importBook(
      page,
      buildEpubFixture({
        title: `Contents ${version}`,
        epubVersion: version,
        chapters: 3,
        paragraphs: 80,
        toc: [
          { label: 'First chapter', href: 'chapter1.xhtml' },
          {
            label: 'Second chapter',
            href: 'chapter2.xhtml',
            children: [
              { label: 'Middle <em>section</em>', href: 'chapter2.xhtml#paragraph-40' },
              { label: 'Missing section', href: 'chapter2.xhtml#missing' },
              { label: 'External link', href: 'https://example.invalid/' },
            ],
          },
          { label: 'Last chapter', href: 'chapter3.xhtml' },
        ],
      }),
      'contents.epub',
      `Contents ${version}`,
    );
    const summary = page.getByText('Table of contents', { exact: true });
    await summary.focus();
    await page.keyboard.press('Enter');
    const contents = page.getByRole('navigation', { name: 'Book contents' });
    await expect(contents.getByRole('button', { name: 'Missing section' })).toBeDisabled();
    await expect(contents.getByRole('button', { name: 'External link' })).toBeDisabled();
    await expect(contents.locator('ol ol')).toHaveCount(1);
    await expect(contents.locator('em')).toHaveCount(0);
    const target = contents.getByRole('button', { name: 'Middle <em>section</em>', exact: true });
    await target.focus();
    await page.keyboard.press('Enter');
    await expect(summary).toBeFocused();
    await expect(contents).not.toBeVisible();
    await expect.poll(() => targetParagraphVisible(page)).toBe(true);
    await expect.poll(async () => (await position(page)).fraction).toBeGreaterThan(0.4);
    const saved = await position(page);
    expect(saved.locatorValue).toMatch(/^epubcfi\(/);
    await page.getByRole('link', { name: '← Close reader' }).click();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await page.reload();
    await expect.poll(() => targetParagraphVisible(page)).toBe(true);
    await summary.click();
    await expect(contents.getByRole('button', { name: 'Last chapter' })).toBeEnabled();
    await contents.getByRole('button', { name: 'Last chapter' }).click();
    await expect.poll(async () => (await position(page)).fraction).toBeGreaterThan(0.65);
  });
}
