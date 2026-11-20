import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
          // Set PW_CHANNEL=msedge to run locally with an installed Edge build
          // when the bundled Chromium download is unavailable.
          channel: process.env.PW_CHANNEL || undefined,
        },
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          firefoxUserPrefs: {
            "webgl.force-enabled": true,
            "webgl.disabled": false,
            "gfx.webrender.software": true,
          },
        },
      },
    },
    {
      name: "webkit",
      // WebKit on Windows can fail while closing a retained trace artifact
      // (ENOENT in .playwright-artifacts) even when the test body passed.
      // Keep screenshots, but disable traces for this project.
      use: { ...devices["Desktop Safari"], trace: "off" },
    },
  ],
  webServer: {
    command: "npm run preview -- --port 4173 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
