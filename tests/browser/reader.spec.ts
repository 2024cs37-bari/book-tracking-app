import { expect, test, type Page } from '@playwright/test';
import { buildEpubFixture, buildPdfFixture } from '../support/fixtures';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('requestfailed', (request) =>
    console.error('Request failed:', request.url(), request.failure()),
  );
});
test.afterEach(() => expect(browserErrors).toEqual([]));

async function importBook(
  page: Page,
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  title: string,
) {
  await page.goto('/');
  await page.locator('.app-nav').waitFor();
  await page.evaluate(
    ({ bytes, filename }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], filename));
      const input = document.querySelector<HTMLInputElement>('#library-import')!;
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { bytes: Array.from(bytes), filename },
  );
  await page
    .getByRole('link', { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .click();
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
}

async function position(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('book-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<
      { locatorKind?: string; locatorValue?: string; fraction: number }[]
    >((resolve, reject) => {
      const request = db.transaction('progress').objectStore('progress').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows[0]!;
  });
}

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
  const canvas = page.locator('.pdf-scroll canvas');
  await expect(canvas).toHaveAttribute('aria-label', 'Page 1 of 30');
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
