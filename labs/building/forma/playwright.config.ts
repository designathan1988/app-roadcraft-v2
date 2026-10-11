import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5792',
    viewport: { width: 1440, height: 860 },
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] },
  },
  webServer: {
    command: 'npx vite --port 5792 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5792',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
