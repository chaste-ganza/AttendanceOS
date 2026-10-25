import { test, expect } from '@playwright/test';

test.describe('Docker Compose Variant', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:8080');
  });

  test('docker compose variant loads correctly', async ({ page }) => {
    await page.goto('http://localhost:8080');
    
    // Verify nginx is serving
    const response = await page.goto('http://localhost:8080');
    expect(response.status()).toBe(200);
    
    // Verify it's the frontend app (HTML contains app-specific text)
    const content = await page.content();
    expect(content).toContain('AttendanceOS');
  });

  test('API proxy works from docker compose', async ({ request }) => {
    const response = await request.get('http://localhost:8080/api/health');
    expect(response.status()).toBe(200);
    
    const json = await response.json();
    expect(json).toHaveProperty('status');
  });
});
