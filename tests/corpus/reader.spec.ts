import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { CORE_CORPUS } from '../../tooling/corpus-manifest';
import { readCorpusSample } from '../../tooling/corpus-files';
import { importBook, position } from '../browser/support';
import { buildImageHeavyPdfFixture } from '../support/fixtures';

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === 'chromium') {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  await page.addInitScript(() => {
    const state = window as Window & {
      readerLongTasks?: number[];
      readerLongTaskSupported?: boolean;
    };
    state.readerLongTaskSupported = PerformanceObserver.supportedEntryTypes.includes('longtask');
    state.readerLongTasks = [];
    if (state.readerLongTaskSupported)
      new PerformanceObserver((list) => {
        state.readerLongTasks!.push(...list.getEntries().map((entry) => entry.duration));
      }).observe({ type: 'longtask', buffered: true });
  });
});

async function report(
  page: Page,
  info: TestInfo,
  timings: Record<string, number>,
  resources: Record<string, number> = {},
) {
  const browser = page.context().browser()!;
  const metrics = await page.evaluate(() => {
    const state = window as Window & {
      readerLongTasks?: number[];
      readerLongTaskSupported?: boolean;
    };
    const memory = performance as Performance & { memory?: { usedJSHeapSize: number } };
    return {
      longTasksMs: state.readerLongTaskSupported ? state.readerLongTasks : null,
      longTaskWindow: 'current document since last navigation/reload',
      jsHeapUsedBytes: memory.memory?.usedJSHeapSize ?? null,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    };
  });
  const result = {
    sample: info.title,
    browser: info.project.name,
    browserVersion: browser.version(),
    cpuThrottleRate: info.project.name === 'chromium' ? 4 : null,
    timingsMs: timings,
    resources,
    metrics,
    environment: 'desktop runner, mobile-sized viewport; not physical mobile hardware',
    timingScope:
      'workflow timings include navigation/automation, fixture DataTransfer materialization and progress-save debounce; not Core Web Vitals',
    memoryScope:
      'JS heap is non-standard and excludes worker/native/GPU allocations; canvas bytes are estimated RGBA backing only',
  };
  await info.attach('reader-measurements', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  console.info(`READER_MEASUREMENTS ${JSON.stringify(result)}`);
}

async function clock(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}
async function offlineReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

for (const sample of CORE_CORPUS) {
  test(`real-file ${sample.id}: metadata, navigation and offline resume at mobile size`, async ({
    page,
    context,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const bytes = await readCorpusSample(sample);
    const start = Date.now();
    await importBook(page, bytes, sample.filename, sample.title);
    const importAndOpenMs = Date.now() - start;
    if (sample.id === 'moby-dick') {
      await page.getByText('Table of contents', { exact: true }).click();
      const contents = page.getByRole('navigation', { name: 'Book contents' });
      await expect(contents.getByRole('button').first()).toBeEnabled();
      const chapter = contents.getByRole('button', { name: /Loomings/i }).first();
      await chapter.click();
      await expect
        .poll(async () =>
          (
            await Promise.all(
              page
                .frames()
                .filter((frame) => frame.url().startsWith('blob:'))
                .map(async (frame) =>
                  (
                    await frame
                      .locator('body')
                      .textContent()
                      .catch(() => '')
                  )?.includes('Call me Ishmael.'),
                ),
            )
          ).some(Boolean),
        )
        .toBe(true);
      const frame = page.frames().find((frame) => frame.url().startsWith('blob:'))!;
      expect(
        await frame.evaluate(async () => {
          await document.fonts.ready;
          return Array.from(document.fonts).filter((font) => font.status === 'loaded').length;
        }),
      ).toBeGreaterThan(0);
    } else if (sample.id === 'svg-in-spine') {
      await expect
        .poll(() => page.frames().filter((frame) => frame.url().startsWith('blob:')).length)
        .toBeGreaterThan(0);
      const frame = page.frames().find((frame) => frame.url().startsWith('blob:'))!;
      await expect(frame.locator('svg').first()).toBeVisible();
      expect(await frame.locator('svg text, svg path, svg image').count()).toBeGreaterThan(0);
    } else {
      await expect(page.locator('.pdf-scroll canvas[data-render-state="ready"]')).toHaveCount(1);
      expect(
        await page.locator('.pdf-scroll canvas').evaluate((element) => {
          const canvas = element as HTMLCanvasElement;
          const data = canvas
            .getContext('2d')!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          return data.some((value, index) => index % 4 !== 3 && value < 100);
        }),
      ).toBe(true);
    }
    await expect.poll(async () => (await position(page)).locatorValue).toBeTruthy();
    const before = await position(page);
    const turnStart = await clock(page);
    if (sample.format === 'epub') {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect
        .poll(async () => (await position(page)).locatorValue)
        .not.toBe(before.locatorValue);
    } else {
      await page.getByText('Reader settings', { exact: true }).click();
      await page.getByLabel('Font size / PDF zoom', { exact: true }).evaluate((element) => {
        const input = element as HTMLInputElement;
        input.value = '36';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await expect(page.locator('.pdf-scroll canvas[data-render-state="ready"]')).toHaveCount(1);
      await page.locator('.pdf-scroll').evaluate((element) => {
        element.scrollTop = 100;
        element.dispatchEvent(new Event('scroll'));
      });
      await expect.poll(async () => (await position(page)).locatorValue).toMatch(/^0:[1-9]/);
    }
    const navigationMs = (await clock(page)) - turnStart;
    const saved = await position(page);
    await page.getByRole('link', { name: '← Close reader' }).click();
    await offlineReady(page);
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await expect(page.locator('.reader-shell')).not.toContainText(
      'Position restored approximately',
    );
    await expect
      .poll(async () => Math.abs((await position(page)).fraction - saved.fraction))
      .toBeLessThan(0.02);
    expect(errors).toEqual([]);
    await report(
      page,
      info,
      { importAndOpen: importAndOpenMs, interactionAndSave: navigationMs },
      { inputBytes: bytes.length },
    );
  });
}

test('generated 240-page image PDF: mobile-size raster bounds and page-turn measurements', async ({
  page,
}, info) => {
  const bytes = buildImageHeavyPdfFixture();
  const start = Date.now();
  await importBook(page, bytes, 'Mobile Stress.pdf', 'Mobile Stress');
  const canvas = page.locator('.pdf-scroll canvas[data-render-state="ready"]');
  await expect(canvas).toHaveCount(1);
  expect(
    await canvas.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const pixel = canvas
        .getContext('2d')!
        .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      return pixel[3] === 255 && Array.from(pixel.slice(0, 3)).some((channel) => channel < 245);
    }),
  ).toBe(true);
  const firstRenderMs = Date.now() - start;
  const timings: number[] = [];
  let maxPixels = 0;
  for (let index = 1; index <= 12; index++) {
    const before = await clock(page);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(canvas).toHaveAttribute('aria-label', `Page ${index + 1} of 240`);
    await expect(canvas).toHaveCount(1);
    timings.push((await clock(page)) - before);
    const pixels = await canvas.evaluate(
      (element) => (element as HTMLCanvasElement).width * (element as HTMLCanvasElement).height,
    );
    maxPixels = Math.max(maxPixels, pixels);
    expect(pixels).toBeLessThanOrEqual(4_000_000);
  }
  await page.getByRole('link', { name: '← Close reader' }).click();
  await expect(page.locator('.pdf-scroll canvas')).toHaveCount(0);
  timings.sort((a, b) => a - b);
  await report(
    page,
    info,
    {
      importAndFirstRender: firstRenderMs,
      pageTurnMedian: timings[Math.floor(timings.length / 2)]!,
      pageTurnMax: timings.at(-1)!,
    },
    {
      inputBytes: bytes.length,
      maxCanvasPixels: maxPixels,
      estimatedRgbaCanvasBytes: maxPixels * 4,
      pages: 240,
      cachedCanvases: 1,
    },
  );
});
