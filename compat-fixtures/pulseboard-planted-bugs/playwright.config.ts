import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/generated',
  // 60 s per test — Supabase auth + Next.js SSR can easily push past 30 s on cold starts.
  timeout: 60000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: [
    ['list'],
    ['json', { outputFile: 'healix-reports/results/results.json' }],
    ['html', { open: 'never', outputFolder: 'healix-reports/html-report' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4801',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'tierA-public',
      grepInvert: /@auth|@tierB|@api|@tierC/,
      retries: 2,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'tierC-backend',
      grep: /@api|@tierC/,
      retries: 1,
      use: { ...devices['Desktop Chrome'] },
    }
  ],
});
