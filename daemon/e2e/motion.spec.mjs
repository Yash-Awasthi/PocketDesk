// SPDX-License-Identifier: GPL-3.0-or-later
// The hub animates one thing: a toast fades its opacity out. The OS setting that asks for less motion
// has to win over it, and a browser that asked for nothing has to keep the fade.
import { expect, test } from "@playwright/test";
import { startFakeDaemon } from "./fake-daemon.mjs";

let daemon;

test.beforeEach(async () => {
  daemon = await startFakeDaemon();
});

test.afterEach(async () => {
  await daemon.close();
});

/** A toast built by hand: the class is what the stylesheet keys on, no JS needed to measure it. */
async function toastDuration(page) {
  return page.evaluate(() => {
    const el = globalThis.document.createElement("div");
    el.className = "toast";
    el.textContent = "probe";
    globalThis.document.querySelector("#toasts").append(el);
    const seconds = globalThis.getComputedStyle(el).transitionDuration;
    el.remove();
    return seconds;
  });
}

test("the toast fade stops when the OS asks for less motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${daemon.url}/#go=home`);
  await expect(page.locator("body")).toHaveClass(/online/);

  expect(await toastDuration(page), "a browser with no preference keeps the toast fade on .toast").toBe(
    "0.4s",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await toastDuration(page),
    "prefers-reduced-motion: reduce has to zero the transition duration on .toast",
  ).toBe("0s");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await toastDuration(page), "turning the setting back off restores the fade on .toast").toBe("0.4s");
});
