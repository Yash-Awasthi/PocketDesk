// SPDX-License-Identifier: GPL-3.0-or-later
// The hub's browser tests. They need the Chromium that `npx playwright install chromium` fetches.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "retain-on-failure" },
});
