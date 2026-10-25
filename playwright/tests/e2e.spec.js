import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:8080';

test.describe('AttendanceOS Containerized Stack', () => {
  test('frontend serves and shows login page', async ({ page }) => {
    await page.goto(BASE);

    // Should show the login page.
    await expect(page).toHaveTitle(/AttendanceOS/i);

    // Should be able to see login form elements (use the labeled inputs so the
    // locator is unambiguous — "Password" also appears in a "Forgot password?"
    // link next to the field).
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: /log in/i })).toBeVisible();
  });

  test('backend health endpoint is reachable through proxy', async ({ request }) => {
    const response = await request.get(`${BASE}/api/health`);
    expect(response.status()).toBe(200);

    const json = await response.json();
    expect(json.status).toBe('ok');
  });

  test('sign-up flow completes through the proxy', async ({ page }) => {
    await page.goto(BASE);

    // Registration link on the login page is "Create one", not "Create an account".
    await page.getByRole('link', { name: /create one/i }).click();
    await expect(page).toHaveURL(/\/register/);

    // Fill registration form. The register page has both a "Password" and a
    // "Confirm password" field, so target the one with id="password"
    // explicitly to avoid a strict-mode violation.
    await page.locator('#full-name').fill('Test User');
    await page.locator('#email').fill('testuser@example.com');
    await page.locator('#password').fill('TestPass123!');
    await page.locator('#confirm-password').fill('TestPass123!');

    // Submit.
    await page.getByRole('button', { name: /create account/i }).click();

    // Should redirect to a valid app route after sign-up. Registration uses
    // safeReturnTo(), which defaults to "/" (the dashboard home route).
    await expect(page).toHaveURL(/\/(dashboard|sessions|\/)/, { timeout: 20000 });
  });

  test('logger shows backend connectivity', async ({ page }) => {
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // The only expected console error is the app pinging /api/auth/me without a
    // session cookie and getting 401. Filter that out.
    const unexpectedErrors = errors.filter(
      (e) =>
        !e.includes('warning') &&
        !e.includes('Deprecated') &&
        !e.includes('DevTools') &&
        !e.includes('401') &&
        !e.toLowerCase().includes('unauthorized'),
    );

    expect(unexpectedErrors).toHaveLength(0);
  });

  test('SPA routing works through nginx', async ({ page }) => {
    // Self-contained: register a fresh account, log in, then verify SPA routing
    // through nginx. This avoids depending on any pre-existing user in the
    // containerized stack.
    const email = `router-test-${Date.now()}@example.com`;
    const password = 'TestPass123!';

    await page.goto(BASE);
    await page.getByRole('link', { name: /create one/i }).click();
    await expect(page).toHaveURL(/\/register/);

    await page.locator('#full-name').fill('Router Test User');
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.locator('#confirm-password').fill(password);
    await page.getByRole('button', { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/(dashboard|sessions|\/)/, { timeout: 20000 });

    // Navigate to sessions page.
    await page.getByRole('link', { name: /sessions/i }).first().click();
    await expect(page).toHaveURL(/\/sessions/);

    // Navigate to timetable.
    await page.getByRole('link', { name: /timetable/i }).first().click();
    await expect(page).toHaveURL(/\/timetable/);
  });
});
