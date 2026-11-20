import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1,
  use: { baseURL: 'https://dumpling233.github.io/bwatch-monitor/', trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run preview', url: 'http://127.0.0.1:4173/bwatch-monitor/', reuseExistingServer: !process.env.CI },
    { command: 'npm run dev', url: 'http://127.0.0.1:5173/', reuseExistingServer: !process.env.CI }
  ]
});
