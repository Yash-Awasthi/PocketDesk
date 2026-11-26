// SPDX-License-Identifier: GPL-3.0-or-later
// Captures one 1280x800 PNG per hub page into docs/screenshots/before, against the fake daemon.
// Run from the daemon directory: cd daemon && node e2e/capture-screenshots.mjs
/* global document, requestAnimationFrame */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startFakeDaemon } from "./fake-daemon.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, "..", "public", "ui");
const OUT = path.resolve(HERE, "..", "..", "docs", "screenshots", "before");
const FREEZE = new Date("2026-11-26T12:00:00.000Z");
const QUIET = [
  "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
  ":focus,:focus-visible{outline:none!important}",
].join("");

// Page ids come from the registrations themselves, so a new page needs no list edited here.
function pageIds() {
  const ids = new Set();
  for (const file of fs.readdirSync(UI)) {
    if (!file.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(UI, file), "utf8");
    for (const m of src.matchAll(/PD\.page\("([a-z]+)"/g)) ids.add(m[1]);
  }
  if (ids.size < 18) throw new Error(`found ${ids.size} pages under ${UI}, expected at least 18`);
  return [...ids].sort();
}

// Several pages draw from an HTTP or websocket reply, so the screenshot waits for the DOM to stop
// changing rather than for a fixed delay: two identical reads in a row mean the page has painted.
async function settle(page) {
  await page.waitForLoadState("networkidle");
  let prev = "";
  for (let i = 0; i < 40; i++) {
    const html = await page.evaluate(() => document.body.outerHTML);
    if (html === prev) return;
    prev = html;
    await page.waitForTimeout(100);
  }
}

const ids = pageIds();
fs.mkdirSync(OUT, { recursive: true });
// Drop old files first: a page that went away must not leave a stale baseline behind.
for (const file of fs.readdirSync(OUT)) if (file.endsWith(".png")) fs.rmSync(path.join(OUT, file));

let daemon;
let browser;
try {
  daemon = await startFakeDaemon();
  // Fixed rasterisation: subpixel text and multi-threaded tile raster are the two things that make
  // an identical page encode to a different PNG on another run.
  browser = await chromium.launch({
    args: [
      "--disable-lcd-text",
      "--font-render-hinting=none",
      "--force-color-profile=srgb",
      "--disable-gpu",
      "--num-raster-threads=1",
      "--disable-partial-raster",
      "--disable-checker-imaging",
      "--run-all-compositor-stages-before-draw",
      "--disable-new-content-rendering-timeout",
    ],
  });
  let total = 0;
  for (const id of ids) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
    });
    try {
      const page = await context.newPage();
      await page.clock.setFixedTime(FREEZE);
      await page.goto(`${daemon.url}/#go=${id}`);
      await page.waitForFunction(() => document.body.classList.contains("online"));
      // The section is shown by the app, not by CSS. The fake daemon does answer desktop_monitors,
      // so the wait is only for the app to unhide the section.
      await page.locator(`#page-${id}`).waitFor({ state: "attached" });
      await page.waitForFunction((pid) => {
        const sec = document.getElementById(`page-${pid}`);
        return !!sec && !sec.hidden;
      }, id);
      await settle(page);
      await page.addStyleTag({ content: QUIET });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => document.activeElement?.blur());
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      const file = path.join(OUT, `${id}.png`);
      await page.screenshot({
        path: file,
        fullPage: false,
        animations: "disabled",
        caret: "hide",
        scale: "css",
        type: "png",
      });
      const bytes = fs.statSync(file).size;
      total += bytes;
      console.log(`${id}.png ${bytes} bytes`);
    } finally {
      await context.close();
    }
  }
  console.log(`${ids.length} files, ${total} bytes total`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (daemon) await daemon.close();
}
