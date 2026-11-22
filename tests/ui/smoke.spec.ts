import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Keep UI tests deterministic and prevent writes or reads against the live company database.
  await page.route('https://**.supabase.co/**', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Supabase is intentionally offline in the UI test fixture.' }),
    });
  });
});

test('health endpoint responds before browser tests run', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({ status: 'ok', service: 'holoo-apex-corporate-erp' });
});

test('dashboard shell renders in local-only mode without cloud access', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'منوی اصلی بیلیون' });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'داشبورد مدیریت مالی' })).toBeVisible();
  await expect(page.getByText('بیلیون', { exact: true }).first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('F1 opens and closes the keyboard shortcut guide', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('F1');
  const dialogTitle = page.getByRole('heading', { name: 'کلیدهای میانبر استاندارد هلو شرکتی Apex' });
  await expect(dialogTitle).toBeVisible();
  await page.getByRole('button', { name: 'بستن', exact: true }).click();
  await expect(dialogTitle).not.toBeVisible();
});

test('audit center is reachable from the main navigation and exposes CSV export', async ({ page }) => {
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'منوی اصلی بیلیون' });
  const auditEntry = navigation.getByRole('button', { name: 'مرکز حسابرسی و کنترل اسناد' });
  await expect(auditEntry).toBeVisible();
  await auditEntry.click();
  await expect(page.getByRole('button', { name: 'خروجی حسابرسی (CSV)' })).toBeVisible();
});

test('PWA deep link opens the FIFO lot valuation management report', async ({ page }) => {
  await page.goto('/?view=reports&action=inventory-lots');
  await expect(page.getByRole('heading', { name: 'ارزش موجودی به تفکیک بچ و انبار' })).toBeVisible();
  await expect(page.getByText('هنوز بچی برای ارزش‌گذاری ثبت نشده است.')).toBeVisible();
});

test('mobile drawer opens and closes without leaving the current page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'منو' }).click();
  const closeButton = page.getByRole('button', { name: 'بستن منو' });
  await expect(closeButton).toBeVisible();
  await closeButton.click();
  await expect(closeButton).not.toBeVisible();
  await expect(page.getByRole('navigation', { name: 'منوی اصلی بیلیون' })).not.toBeVisible();
});
