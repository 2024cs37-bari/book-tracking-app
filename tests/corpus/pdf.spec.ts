import { expect, test, type Page } from '@playwright/test';
import { PDF_CORPUS } from '../../tooling/corpus-manifest';
import { readCorpusSample } from '../../tooling/corpus-files';
import { importBook, importStoredBook, position } from '../browser/support';
import { attachEvidence } from './evidence';

async function readyPage(page: Page, number: number, total: number): Promise<void> {
  const canvas = page.locator('.pdf-scroll canvas[data-render-state="ready"]');
  await expect(canvas).toHaveAttribute('aria-label', `Page ${number} of ${total}`);
  await expect(canvas).toHaveCount(1);
  expect(
    await canvas.evaluate(
      (element) => (element as HTMLCanvasElement).width * (element as HTMLCanvasElement).height,
    ),
  ).toBeLessThanOrEqual(4_000_000);
}

async function painted(page: Page, expected = true): Promise<void> {
  expect(
    await page.locator('.pdf-scroll canvas[data-render-state="ready"]').evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 !== 3 && value < 180);
    }),
  ).toBe(expected);
}

async function selectPage(page: Page, number: number): Promise<void> {
  const sidebar = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
  if ((await sidebar.getAttribute('aria-expanded')) !== 'true') await sidebar.click();
  await page.getByRole('tab', { name: 'Pages', exact: true }).click();
  await page.getByRole('button', { name: String(number), exact: true }).click();
  await page.getByRole('button', { name: 'Close sidebar', exact: true }).click();
}

for (const sample of PDF_CORPUS) {
  test(`PDF corpus ${sample.id}: real rendering or explicit limit, original preservation and cleanup`, async ({
    page,
    context,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const bytes = await readCorpusSample(sample);
    const environment = {
      browser: info.project.name,
      browserVersion: context.browser()!.version(),
      viewport: page.viewportSize(),
      deviceScaleFactor: 2,
      cpuThrottleRate: null,
      scope: 'desktop runner, mobile-sized viewport; not physical mobile hardware',
    };
    if (sample.kind === 'invalid') {
      await importStoredBook(page, bytes, sample.filename, sample.title);
      await page.getByRole('button', { name: 'Read', exact: true }).click();
      await expect(
        page
          .locator('.reader-shell')
          .getByRole('status')
          .filter({ hasText: 'Could not open book' }),
      ).toContainText('Could not open book');
      await expect(page.locator('.pdf-scroll canvas')).toHaveCount(0);
      expect((await position(page)).locatorValue).toBeUndefined();
      await page.getByRole('link', { name: '← Close reader' }).click();
      await page.getByText('Local file', { exact: true }).click();
      await page.getByRole('button', { name: 'Check local file', exact: true }).click();
      await expect(page.locator('.details').getByRole('status')).toContainText(
        'original file is present',
      );
      expect(errors).toEqual([]);
      await attachEvidence(info, 'pdf-corpus-evidence', {
        environment,
        id: sample.id,
        sha256: sample.sha256,
        observations: [
          { result: 'invalid structure rejected; original retained; no locator/canvas created' },
        ],
      });
      return;
    }
    await importBook(page, bytes, sample.filename, sample.title);
    await readyPage(page, 1, sample.pages);
    await painted(page);
    await expect.poll(async () => (await position(page)).locatorValue).toMatch(/^0:/);
    const observations: {
      page: number;
      pixels?: number;
      width?: number;
      height?: number;
      aspectRatio?: number;
      result: string;
    }[] = [];
    const visited = Math.min(sample.pages, 12);
    let lastGood = 1;
    let displayedPage = 1;
    for (let number = 1; number <= visited; number++) {
      const savedBeforeNavigation = await position(page);
      if (number > 1) await selectPage(page, number);
      if ((sample.limitedPages as readonly number[]).includes(number)) {
        await expect(
          page
            .locator('.reader-shell')
            .getByRole('status')
            .filter({ hasText: 'Image exceeded maximum allowed size' }),
        ).toContainText('Image exceeded maximum allowed size');
        await readyPage(page, displayedPage, sample.pages);
        await page.waitForTimeout(450);
        expect((await position(page)).locatorValue).toBe(savedBeforeNavigation.locatorValue);
        observations.push({
          page: number,
          result: 'explicit image decode limit; prior good page and locator retained',
        });
        continue;
      }
      await readyPage(page, number, sample.pages);
      displayedPage = number;
      const blank = (sample.blankPages as readonly number[]).includes(number);
      await painted(page, !blank);
      await expect
        .poll(async () => (await position(page)).locatorValue)
        .toMatch(new RegExp(`^${number - 1}:`));
      const raster = await page.locator('.pdf-scroll canvas').evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        return {
          pixels: canvas.width * canvas.height,
          width: canvas.width,
          height: canvas.height,
          aspectRatio: canvas.width / canvas.height,
        };
      });
      const expectedAspect = (sample.aspectRatios as readonly number[])[number - 1];
      // Raster dimensions are integer pixels. For the 8:1 page, a valid
      // 684 × 85.5 viewport becomes 684 × 85; an absolute ratio tolerance
      // rejects that half-pixel quantization. Bound the deviation to one
      // pixel in either dimension while still detecting distorted pages.
      if (expectedAspect)
        expect(Math.abs(raster.width - raster.height * expectedAspect)).toBeLessThanOrEqual(
          Math.max(1, expectedAspect),
        );
      observations.push({
        page: number,
        ...raster,
        result: blank ? 'intentional blank page; render completed' : 'painted',
      });
      if (!blank) lastGood = number;
    }
    // If the final tested page is blank or decode-limited, return to a painted page.
    if (displayedPage !== lastGood) await selectPage(page, lastGood);
    await readyPage(page, lastGood, sample.pages);
    await expect
      .poll(async () => (await position(page)).locatorValue)
      .toMatch(new RegExp(`^${lastGood - 1}:`));
    const saved = await position(page);
    await page.getByRole('link', { name: '← Close reader' }).click();
    await expect(page.locator('.pdf-scroll canvas')).toHaveCount(0);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await readyPage(page, lastGood, sample.pages);
    await page.reload();
    await readyPage(page, lastGood, sample.pages);
    await expect.poll(async () => (await position(page)).locatorValue).toBe(saved.locatorValue);
    await painted(page);
    expect(errors).toEqual([]);
    await attachEvidence(info, 'pdf-corpus-evidence', {
      environment,
      id: sample.id,
      sha256: sample.sha256,
      actualPages: sample.pages,
      observations,
      scope: `first ${visited} pages checked; remaining pages not claimed; limits retained`,
    });
  });
}
