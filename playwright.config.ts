import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3317",
    trace: "retain-on-failure",
    launchOptions: process.env.BROWSER_EXECUTABLE
      ? { executablePath: process.env.BROWSER_EXECUTABLE }
      : {},
    screenshot: "only-on-failure",
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  webServer: {
    command:
      "AGENT_MODE=demo EMAIL_MOCK_FAILURES=1 SESSION_DB_PATH=.data/browser-tests.sqlite PORT=3317 bun src/server.ts",
    url: "http://127.0.0.1:3317/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
