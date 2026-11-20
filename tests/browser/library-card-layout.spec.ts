import { expect, test, type Locator, type Page } from '@playwright/test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { BookRow, ProgressRow } from '../../src/data/db';
import { buildEpubFixture, buildImageFixture } from '../support/fixtures';
import { importStoredBook } from './support';

test.use({ reducedMotion: 'no-preference' });

const books = [
  { title: 'A Tiny', creator: 'Li', fraction: 0, status: 'to_read' },
  {
    title:
      'B An exceptionally long title about journeys through a personal library with enough words to wrap across several lines and retain its complete accessible name',
    creator: 'Alexandra Catherine Montgomery and the International Society of Library Historians',
    fraction: 0.37,
    status: 'reading',
  },
  { title: 'C Brief', creator: '', fraction: 0, status: 'to_read' },
  {
    title:
      'D Another deliberately lengthy title that makes the author and reading status line up with the neighbouring short title rather than following the amount of text',
    creator: 'Jo Author',
    fraction: 1,
    status: 'finished',
  },
  {
    title: 'E Notes',
    creator:
      'Professor Elizabeth Wilhelmina Rutherford of the Institute for Comparative Literature',
    fraction: 0,
    status: 'abandoned',
  },
  {
    title:
      'F A final extended title for a book with an unknown author and a saved reading position, ensuring the next grid row also shares stable text and progress slots',
    creator: '',
    fraction: 0.65,
    status: 'reading',
  },
] as const;

async function seedLibrary(page: Page) {
  const ids: string[] = [];
  for (const [index, book] of books.entries()) {
    let bytes = buildEpubFixture({
      title: book.title,
      creator: book.creator,
      withCover: index === 0,
    });
    if (index === 0) {
      // The default cover is a JPEG header, not a decodable image. Embed the
      // existing landscape PNG fixture so object-fit: cover would crop it.
      const entries = unzipSync(bytes);
      entries['OEBPS/images/cover.png'] = buildImageFixture();
      delete entries['OEBPS/images/cover.jpg'];
      entries['OEBPS/content.opf'] = strToU8(
        strFromU8(entries['OEBPS/content.opf']!)
          .replace('images/cover.jpg', 'images/cover.png')
          .replace('image/jpeg', 'image/png'),
      );
      bytes = zipSync({
        ...entries,
        mimetype: [entries['mimetype']!, { level: 0 }],
      });
    }
    await importStoredBook(page, bytes, `card-layout-${index}.epub`, book.title);
    // importStoredBook ends on details, not the library.
    await expect(page.locator('.details h1')).toHaveText(book.title);
    ids.push(new URL(page.url()).pathname.split('/').at(-1)!);
  }

  // Only modify the synthetic imports in this test's isolated browser context.
  await page.evaluate(
    async (fixtures) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('book-reader');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(['books', 'progress'], 'readwrite');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new Error('Layout fixture transaction aborted'));
          for (const [index, fixture] of fixtures.entries()) {
            const request = tx.objectStore('books').get(fixture.bookId);
            request.onsuccess = () => {
              const row = request.result as BookRow | undefined;
              if (!row || row.title !== fixture.title) {
                tx.abort();
                return;
              }
              tx.objectStore('books').put({ ...row, metadataIncomplete: index === 1 });
              const progress: ProgressRow = {
                bookId: row.id,
                status: fixture.status,
                fraction: fixture.fraction,
                updatedHlc: row.updatedHlc,
                deviceId: 'card-layout-fixture',
                ...(fixture.fraction > 0
                  ? { locatorKind: 'cfi' as const, locatorValue: 'epubcfi(/6/2!/4/2)' }
                  : {}),
              };
              tx.objectStore('progress').put(progress);
            };
          }
        });
      } finally {
        db.close();
      }
    },
    books.map((book, index) => ({ ...book, bookId: ids[index]! })),
  );
  await page.goto('/');
  await expect(page.locator('.book-card')).toHaveCount(books.length);
  await page.evaluate(() => document.fonts.ready);
}

async function settledCover(link: Locator) {
  const cover = link.locator('.cover');
  await cover.evaluate(async (element) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished.catch(() => {})),
    );
  });
  await expect(cover).toHaveCSS('transform', 'none');
  return cover.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const card = element.closest('.book-card')!.getBoundingClientRect();
    return {
      x: bounds.x - card.x,
      y: bounds.y - card.y,
      width: bounds.width,
      height: bounds.height,
    };
  });
}

for (const width of [320, 390, 587, 1280]) {
  test(`library cards share aligned slots and stationary covers at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await seedLibrary(page);
    await page.mouse.move(0, 0);
    const cards = page.locator('.book-card');
    const image = cards.locator('.cover-card img');
    await expect(image).toHaveCount(1);
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        image.evaluate((element) => {
          const image = element as HTMLImageElement;
          return image.complete && image.naturalWidth === 64 && image.naturalHeight === 32;
        }),
      )
      .toBe(true);
    await expect(image).toHaveCSS('object-fit', 'contain');
    const imageFit = await image.evaluate((element) => {
      const image = element as HTMLImageElement;
      const rect = image.getBoundingClientRect();
      const cover = image.closest('.cover-card')!.getBoundingClientRect();
      const scale = Math.min(
        image.clientWidth / image.naturalWidth,
        image.clientHeight / image.naturalHeight,
      );
      return {
        withinCover:
          rect.x >= cover.x - 1 &&
          rect.y >= cover.y - 1 &&
          rect.right <= cover.right + 1 &&
          rect.bottom <= cover.bottom + 1,
        fullWidth: image.naturalWidth * scale <= image.clientWidth + 1,
        fullHeight: image.naturalHeight * scale <= image.clientHeight + 1,
      };
    });
    expect(imageFit, 'the complete landscape artwork fits inside its portrait cover').toEqual({
      withinCover: true,
      fullWidth: true,
      fullHeight: true,
    });
    await expect(cards.locator('.book-card-text > progress.book-progress')).toHaveCount(
      books.length,
    );
    await expect(cards.locator('.book-card-text > .book-card-notice')).toHaveCount(books.length);
    await expect(cards.locator('.book-card-notice .badge-warning')).toHaveCount(1);

    for (const book of books) {
      const card = cards.filter({ has: page.locator('.book-title', { hasText: book.title }) });
      await expect(card.locator('.book-card-text > .book-title')).toHaveText(book.title);
      await expect(card.locator('.book-title')).toHaveAttribute('title', book.title);
      const escapedTitle = book.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await expect(card.getByRole('link')).toHaveAccessibleName(new RegExp(escapedTitle));
      await expect(card.locator('.book-card-text > .book-author')).toHaveText(
        book.creator || 'Unknown author',
      );
      await expect(card.locator('.book-progress')).toHaveAttribute('value', String(book.fraction));
      await expect(card.locator('.book-meta .badge-status')).toHaveClass(
        new RegExp(`\\bbadge-status-${book.status}\\b`),
      );
    }

    const selectors = [
      '.book-cover-stage',
      '.cover-card',
      '.book-card-text > .book-title',
      '.book-card-text > .book-author',
      '.book-card-text > .book-meta',
      '.book-meta .badge-status',
      '.book-card-text > .book-progress',
      '.book-card-text > .book-card-notice',
    ];
    const geometry = await cards.evaluateAll((elements, parts) => {
      const bounds = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom,
        };
      };
      return elements.map((card) => {
        const stage = card.querySelector('.book-cover-stage')!;
        const stageBounds = bounds(stage);
        const style = getComputedStyle(stage);
        return {
          title: card.querySelector('.book-title')!.textContent,
          card: bounds(card),
          coverArea: {
            left: stageBounds.x + parseFloat(style.paddingLeft),
            top: stageBounds.y + parseFloat(style.paddingTop),
            right: stageBounds.right - parseFloat(style.paddingRight),
            bottom: stageBounds.bottom - parseFloat(style.paddingBottom),
          },
          parts: parts.map((selector) => {
            const element = card.querySelector(selector);
            if (!element) throw new Error(`Missing card slot: ${selector}`);
            return { selector, ...bounds(element) };
          }),
          overflows: card.scrollWidth > card.clientWidth + 1,
        };
      });
    }, selectors);
    const rows = new Map<number, typeof geometry>();
    for (const item of geometry) {
      const rowY = [...rows.keys()].find((y) => Math.abs(y - item.card.y) <= 1) ?? item.card.y;
      rows.set(rowY, [...(rows.get(rowY) ?? []), item]);
      expect(item.overflows, `${item.title}: card overflow`).toBe(false);
      expect(item.card.x, `${item.title}: left viewport edge`).toBeGreaterThanOrEqual(-1);
      expect(item.card.right, `${item.title}: right viewport edge`).toBeLessThanOrEqual(width + 1);
      const cover = item.parts.find((part) => part.selector === '.cover-card')!;
      expect(cover.width, `${item.title}: visible cover`).toBeGreaterThan(0);
      expect(cover.height, `${item.title}: visible cover`).toBeGreaterThan(0);
      expect(
        Math.abs(cover.width - cover.height * (2 / 3)),
        `${item.title}: cover preserves its 2:3 ratio`,
      ).toBeLessThanOrEqual(1);
      expect(cover.x, `${item.title}: cover fits stage left`).toBeGreaterThanOrEqual(
        item.coverArea.left - 1,
      );
      expect(cover.y, `${item.title}: cover fits stage top`).toBeGreaterThanOrEqual(
        item.coverArea.top - 1,
      );
      expect(cover.right, `${item.title}: cover fits stage right`).toBeLessThanOrEqual(
        item.coverArea.right + 1,
      );
      expect(cover.bottom, `${item.title}: cover fits stage bottom`).toBeLessThanOrEqual(
        item.coverArea.bottom + 1,
      );
      for (const part of item.parts) {
        expect(part.x, `${item.title}: ${part.selector} left edge`).toBeGreaterThanOrEqual(
          item.card.x - 1,
        );
        expect(part.right, `${item.title}: ${part.selector} right edge`).toBeLessThanOrEqual(
          item.card.right + 1,
        );
        expect(part.bottom, `${item.title}: ${part.selector} bottom edge`).toBeLessThanOrEqual(
          item.card.bottom + 1,
        );
      }
    }
    const sharedRows = [...rows.values()].filter((row) => row.length > 1);
    expect(sharedRows.length, 'layout assertions must compare neighbouring cards').toBeGreaterThan(
      0,
    );
    for (const row of sharedRows) {
      const first = row[0]!;
      for (const item of row.slice(1)) {
        expect(Math.abs(item.card.bottom - first.card.bottom), 'card bottoms').toBeLessThanOrEqual(
          1,
        );
        for (const [index, part] of item.parts.entries()) {
          const reference = first.parts[index]!;
          expect(
            Math.abs(part.y - reference.y),
            `${item.title}: ${part.selector} row alignment`,
          ).toBeLessThanOrEqual(1);
          if (part.selector === '.cover-card' || part.selector === '.book-cover-stage') {
            for (const dimension of ['width', 'height', 'bottom'] as const) {
              expect(
                Math.abs(part[dimension] - reference[dimension]),
                `${item.title}: ${part.selector} ${dimension}`,
              ).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      'library must not overflow the viewport',
    ).toBe(true);

    for (const card of await cards.all()) {
      const link = card.getByRole('link');
      const before = await settledCover(link);
      await link.hover();
      const hovered = await settledCover(link);
      await page.mouse.move(0, 0);
      await link.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(link).toBeFocused();
      await expect(link).toHaveCSS('outline-style', 'solid');
      const focused = await settledCover(link);
      for (const state of [hovered, focused]) {
        for (const dimension of ['x', 'y', 'width', 'height'] as const) {
          expect(Math.abs(state[dimension] - before[dimension]), dimension).toBeLessThanOrEqual(1);
        }
      }
    }
  });
}
