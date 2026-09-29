import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e/embed',
  outputDir: './scratch/todo-test-results',
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:49173',
    channel: process.env.TODO_TEST_CHANNEL,
    viewport: { width: 1280, height: 800 },
    testIdAttribute: 'data-test-id',
    launchOptions: { args: ['--enable-unsafe-swiftshader'] }
  },
  webServer: {
    command: 'bunx vite preview --host 127.0.0.1 --port 49173 --strictPort',
    url: 'http://127.0.0.1:49173',
    reuseExistingServer: false
  }
})
