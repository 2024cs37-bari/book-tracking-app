import { expect, test } from '@playwright/test';

for (const width of [320, 390, 767]) {
  test(`mobile navigation is a full-height off-canvas drawer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    const toggle = page.locator('.app-nav-toggle');
    const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-controls', 'navigation-drawer');
    await expect(page.locator('#navigation-drawer')).toBeHidden();
    expect(await toggle.boundingBox()).toMatchObject({ width: 44, height: 44 });

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(drawer).toBeVisible();
    const close = drawer.getByRole('button', { name: 'Close navigation', exact: true });
    await expect(close).toBeFocused();
    expect(await close.boundingBox()).toMatchObject({ width: 44, height: 44 });
    await expect
      .poll(async () => {
        const rect = await drawer.boundingBox();
        return rect && Math.abs(rect.x + rect.width - width) < 1;
      })
      .toBe(true);
    const bounds = await drawer.boundingBox();
    expect(bounds!.y).toBe(0);
    expect(bounds!.height).toBe(844);
    expect(bounds!.width).toBeLessThanOrEqual(width * 0.85 + 1);
    expect(bounds!.width).toBeLessThanOrEqual(320.01);
    const backdrop = await drawer.evaluate(
      (element) => getComputedStyle(element, '::backdrop').backgroundColor,
    );
    expect(backdrop).not.toBe('rgba(0, 0, 0, 0)');
    for (const name of ['Library', 'Stats', 'Settings']) {
      const link = drawer.getByRole('link', { name, exact: true });
      await expect(link).toBeVisible();
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect(link.locator('svg')).toHaveCount(1);
    }
    await expect(drawer.getByRole('link', { name: 'Library', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator('html')).toHaveClass(/nav-open/);
    await close.click();
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('html')).not.toHaveClass(/nav-open/);
    await expect(page.getByText('A personal library', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Your books, your space.', { exact: false })).toHaveCount(0);
  });
}

test.describe('mobile off-canvas interactions', () => {
  test.use({ viewport: { width: 375, height: 844 } });

  test('keyboard focus enters, wraps in both directions, and returns after Escape', async ({
    page,
  }) => {
    await page.goto('/');
    const toggle = page.locator('.app-nav-toggle');
    const drawer = page.locator('#navigation-drawer');
    const close = drawer.getByRole('button', { name: 'Close navigation', exact: true });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(drawer.getByRole('link', { name: 'Settings', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    for (const name of ['Library', 'Stats', 'Settings']) {
      await page.keyboard.press('Tab');
      await expect(drawer.getByRole('link', { name, exact: true })).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeFocused();
    await expect(page.locator('html')).not.toHaveClass(/nav-open/);
  });

  test('background is inert and backdrop dismisses without activating the page', async ({
    page,
  }) => {
    await page.goto('/');
    const toggle = page.locator('.app-nav-toggle');
    const drawer = page.locator('#navigation-drawer');
    await toggle.click();
    await page.locator('.footer-privacy a').focus();
    expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expect(drawer).toBeVisible();
    await expect(page.locator('html')).toHaveCSS('overflow-y', 'hidden');
    await page.mouse.click(8, 300);
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
    await expect(toggle).toBeFocused();
    await expect(page.locator('html')).not.toHaveClass(/nav-open/);
  });

  test('scroll is locked while open and restored when closed', async ({ page }) => {
    await page.goto('/settings');
    const toggle = page.locator('.app-nav-toggle');
    const drawer = page.locator('#navigation-drawer');
    await toggle.click();
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.move(8, 300);
    await page.mouse.wheel(0, 600);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    await drawer.getByRole('button', { name: 'Close navigation', exact: true }).click();
    await page.mouse.wheel(0, 600);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
  });

  test('routes and selecting the current route dismiss and focus content', async ({ page }) => {
    await page.goto('/');
    const toggle = page.locator('.app-nav-toggle');
    const drawer = page.locator('#navigation-drawer');
    for (const [name, path] of [
      ['Stats', '/stats'],
      ['Settings', '/settings'],
      ['Library', '/'],
    ]) {
      await toggle.click();
      await drawer.getByRole('link', { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(drawer).toBeHidden();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('#main')).toBeFocused();
      await expect(page.locator('html')).not.toHaveClass(/nav-open/);
    }
    await toggle.click();
    await drawer.getByRole('link', { name: 'Library', exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page.locator('#main')).toBeFocused();
  });

  test('browser history and hash navigation dismiss an open drawer', async ({ page }) => {
    await page.goto('/');
    const toggle = page.locator('.app-nav-toggle');
    const drawer = page.locator('#navigation-drawer');
    await toggle.click();
    await drawer.getByRole('link', { name: 'Stats', exact: true }).click();
    await expect(page).toHaveURL(/\/stats$/);
    await toggle.click();
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(drawer).toBeHidden();
    await page.getByRole('link', { name: 'Back up your library' }).click();
    await expect(page).toHaveURL(/\/settings#settings-backups$/);
    await toggle.click();
    await page.goBack();
    await expect(drawer).toBeHidden();
    await expect(page.locator('html')).not.toHaveClass(/nav-open/);
  });

  test('desktop breakpoint closes the modal and restores inline navigation', async ({ page }) => {
    await page.goto('/');
    const toggle = page.locator('.app-nav-toggle');
    const drawer = page.locator('#navigation-drawer');
    await toggle.click();
    await page.setViewportSize({ width: 768, height: 844 });
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeHidden();
    await expect(page.locator('#desktop-navigation')).toBeVisible();
    await expect(page.locator('#desktop-navigation a[aria-current="page"]')).toBeFocused();
    await expect(page.locator('html')).not.toHaveClass(/nav-open/);
    await page.setViewportSize({ width: 767, height: 844 });
    await expect(toggle).toBeVisible();
    await expect(drawer).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('reduced motion removes drawer and backdrop animations', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.locator('.app-nav-toggle').click();
    const drawer = page.locator('#navigation-drawer');
    await expect(drawer).toHaveCSS('animation-name', 'none');
    expect(
      await drawer.evaluate((element) => getComputedStyle(element, '::backdrop').animationName),
    ).toBe('none');
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });
});

for (const width of [768, 1280]) {
  test(`desktop retains inline navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(page.locator('.app-nav-toggle')).toBeHidden();
    await expect(page.locator('#navigation-drawer')).toBeHidden();
    const navigation = page.getByRole('navigation', { name: 'Main', exact: true });
    const links = ['Library', 'Stats', 'Settings'].map((name) =>
      navigation.getByRole('link', { name, exact: true }),
    );
    for (const link of links) await expect(link).toBeVisible();
    const bounds = await Promise.all(links.map((link) => link.boundingBox()));
    expect(bounds[0]!.y).toBe(bounds[1]!.y);
    expect(bounds[1]!.y).toBe(bounds[2]!.y);
  });
}
