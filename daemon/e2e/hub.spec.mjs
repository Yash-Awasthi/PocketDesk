// SPDX-License-Identifier: GPL-3.0-or-later
// The hub's pages against a fake daemon: pairing, the device table, the two-factor section, one
// live session, and an axe pass over the hub and settings pages.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startFakeDaemon } from "./fake-daemon.mjs";

let daemon;

test.beforeEach(async () => {
  daemon = await startFakeDaemon();
});

test.afterEach(async () => {
  await daemon.close();
});

async function open(page, id) {
  await page.goto(`${daemon.url}/#go=${id}`);
  await expect(page.locator("body")).toHaveClass(/online/);
  await expect(page.locator(`#page-${id}`)).toBeVisible();
}

const retry = (page, sel) => page.locator(sel).getByRole("button", { name: "Retry" });

test("the pairing card shows the token and a QR for both scanners", async ({ page }) => {
  await open(page, "thispc");
  const card = page.locator("#page-thispc .card").filter({ hasText: "Pair a phone" });

  await expect(card.getByRole("heading", { name: "Pair a phone" })).toBeVisible();
  await expect(card.locator("input[readonly]")).toHaveValue(daemon.token);
  await expect(card.locator(".qr svg")).toHaveCount(1);
  await expect(card.getByText(/Scan with the PocketDesk app/)).toBeVisible();

  await card.getByRole("tab", { name: "Phone browser" }).click();
  await expect(card.locator(".qr svg")).toHaveCount(1);
  await expect(card.getByText(/Scan with the phone's camera/)).toBeVisible();
  await expect(card.getByText(/192\.168\.1\.10:8765/)).toBeVisible();
});

test("the device table shows platform, last seen and address, and revokes", async ({ page }) => {
  await open(page, "thispc");
  const list = page.locator("#page-thispc .list");

  await expect(list.getByText("Pixel 9 (online)")).toBeVisible();
  await expect(list.getByText(/Android 16 \u00b7 last seen .* 192\.168\.1\.21/)).toBeVisible();
  await expect(list.getByText(/via iroh/)).toBeVisible();
  await expect(list.getByText(/via lan/)).toBeVisible();
  await expect(list.getByText("Old phone (revoked)")).toBeVisible();
  await expect(list.getByRole("button", { name: "Allow" })).toHaveCount(1);

  const note = list.getByLabel("Note for Pixel 9");
  await expect(note).toHaveValue("");
  await note.fill("desk phone");
  await note.blur();
  await expect.poll(() => daemon.calls.some((c) => c.path === "/access/devices/note")).toBe(true);
  await open(page, "thispc");
  await expect(list.getByLabel("Note for Pixel 9")).toHaveValue("desk phone");

  page.on("dialog", (d) => d.accept());
  await list.getByRole("button", { name: "Revoke" }).click();

  await expect.poll(() => daemon.calls.some((c) => c.path === "/access/devices/revoke")).toBe(true);
  await expect(list.getByText("Pixel 9 (revoked)")).toBeVisible();
  await expect(list.getByRole("button", { name: "Allow" })).toHaveCount(2);
});

test("the activity card shows timed device events and names the categories it cannot show", async ({
  page,
}) => {
  await open(page, "thispc");
  const card = page.locator("#page-thispc .card").filter({ hasText: "Activity" });

  await expect(card.getByText("Pixel 9 paired (Android 16)")).toBeVisible();
  await expect(card.getByText("Pixel 9 connected over iroh")).toBeVisible();
  await expect(card.getByText(/^Policy changes: not recorded;/)).toBeVisible();
  await expect(card.getByText(/^Two-factor changes: not recorded;/)).toBeVisible();
  await expect(card.locator(".item .dim").first()).not.toHaveText("never");
});

test("two-factor setup shows the secret and turns on with a code", async ({ page }) => {
  await open(page, "thispc");
  const card = page.locator("#page-thispc .card").filter({ hasText: "Two-factor pairing" });

  await expect(card.getByText(/^Off: the pairing QR alone pairs a new phone/)).toBeVisible();
  await expect(card.getByPlaceholder("6-digit code")).toBeHidden();

  await card.getByRole("button", { name: "Set up" }).click();
  await expect(card.locator(".qr svg")).toHaveCount(1);
  await expect(card.getByText(/Or enter this key in the app: JBSWY3DPEHPK3PXP/)).toBeVisible();
  await expect(card.getByPlaceholder("6-digit code")).toBeVisible();

  await card.getByPlaceholder("6-digit code").fill("123456");
  await card.getByRole("button", { name: "Turn on" }).click();

  await expect(card.getByText(/^On: pairing a new phone also needs a code/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Turn off" })).toBeVisible();
});

test("the running page lists one live terminal session", async ({ page }) => {
  await open(page, "running");
  const card = page.locator("#page-running .card").filter({ hasText: "Sessions" });

  await expect(card.getByText("claude")).toBeVisible();
  await expect(card.getByText(/terminal \u00b7 running/)).toBeVisible();
  await expect(card.getByText("01234567")).toBeVisible();
  await expect(page.locator("#page-running")).not.toHaveText(/Nothing is running/);
  expect(daemon.messages.some((m) => m.type === "running_state")).toBe(true);
});

test("the sessions page searches and filters by agent, project and date", async ({ page }) => {
  await open(page, "sessions");
  const panel = page.locator("#page-sessions");
  const list = panel.locator(".list");
  const count = panel.locator("p.dim.small");

  await expect(list.locator(".item")).toHaveCount(3);
  await expect(count).toHaveText("3 of 3 saved conversations");
  await expect(list.getByText("Fix the build")).toBeVisible();

  const search = panel.getByLabel("Search sessions");
  await search.fill("retries");
  await expect(list.locator(".item")).toHaveCount(1);
  await expect(list.getByText("Add retries")).toBeVisible();
  await search.fill("");

  await panel.getByLabel("Agent").selectOption("claude");
  await expect(list.locator(".item")).toHaveCount(2);
  await panel.getByLabel("Agent").selectOption("");

  await panel.getByLabel("Project").selectOption("api");
  await expect(list.locator(".item")).toHaveCount(1);
  await expect(list.getByText("Add retries")).toBeVisible();
  await panel.getByLabel("Project").selectOption("");

  await panel.getByLabel("From date").fill("2026-11-25");
  await expect(list.locator(".item")).toHaveCount(1);
  await expect(list.getByText("Fix the build")).toBeVisible();

  await panel.getByLabel("From date").fill("2027-01-01");
  await expect(list.locator(".item")).toHaveCount(0);
  await expect(list.getByText("No saved conversation matches these filters.")).toBeVisible();
  await expect(count).toHaveText("0 of 3 saved conversations");
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// The same regex the capture script uses, so neither side owns a hardcoded page list.
function screenshotIds() {
  const ui = path.join(HERE, "..", "public", "ui");
  const ids = new Set();
  for (const file of fs.readdirSync(ui)) {
    if (!file.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(ui, file), "utf8");
    for (const m of src.matchAll(/PD\.page\("([a-z]+)"/g)) ids.add(m[1]);
  }
  return [...ids].sort();
}

// The accessibility claim, bounded: these four rule tags, on every page the module entry registers,
// in both themes. color-contrast is part of wcag2aa, so 4.5:1 for normal text and 3:1 for large is
// enforced here rather than in a second hand-rolled calculation.
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** A full load per page: a goto that only changes the hash leaves the previous page on screen. */
async function visit(page, id) {
  await page.goto("about:blank");
  await open(page, id);
}

test("every hub page passes axe WCAG 2 A/AA in both themes", async ({ page }) => {
  test.setTimeout(300_000);
  const findings = [];
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const id of screenshotIds()) {
      await visit(page, id);
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).include(`#page-${id}`).analyze();
      for (const v of results.violations) {
        for (const n of v.nodes) {
          const why = (n.failureSummary || "").trim().split("\n").pop();
          findings.push(`${theme} ${id}: [${v.id}] ${n.target.join(" ")} :: ${why}`);
        }
      }
    }
  }
  expect(findings, `axe ${AXE_TAGS.join(",")}:\n${findings.join("\n")}`).toEqual([]);
});

// 44 CSS px is 44 dp at 1x, the smallest target this browser can see. Checkbox and radio inputs are
// skipped because their wrapping .check label is the target; inline text links (the "all" link in a
// card heading) are named in plan.md instead of being given a 44 px box.
test("every control is a 44 px target", async ({ page }) => {
  test.setTimeout(300_000);
  const small = [];
  for (const id of screenshotIds()) {
    await visit(page, id);
    const rows = await page.evaluate((pid) => {
      const roots = [globalThis.document.querySelector(`#page-${pid}`)];
      if (pid === "home") roots.push(globalThis.document.querySelector("#side"));
      const sel = 'button, a[href], input, select, textarea, [role="button"], [role="tab"], [tabindex]';
      const out = [];
      for (const el of roots.flatMap((r) => [...r.querySelectorAll(sel)])) {
        if (el.closest("[hidden]")) continue;
        if (/^(checkbox|radio|hidden)$/.test(el.type || "")) continue;
        if (el.matches("a:not(.navlink)")) continue;
        const box = el.getBoundingClientRect();
        if (!box.width && !box.height) continue;
        if (box.width < 44 || box.height < 44) {
          const cls = String(el.className).trim().split(/\s+/).filter(Boolean).join(".");
          const label = (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24);
          out.push(
            `${el.tagName.toLowerCase()}${cls ? "." + cls : ""} ${box.width.toFixed(1)}x${box.height.toFixed(1)} ${label}`,
          );
        }
      }
      return out;
    }, id);
    for (const row of rows) small.push(`${id}: ${row}`);
  }
  expect(small, `controls under 44x44 CSS px:\n${small.join("\n")}`).toEqual([]);
});

test("every hub page has a baseline screenshot", async () => {
  const dir = path.join(HERE, "..", "..", "docs", "screenshots", "before");
  const ids = screenshotIds();
  const bad = [];
  for (const id of ids) {
    let ok = false;
    try {
      const buf = fs.readFileSync(path.join(dir, `${id}.png`));
      ok = buf.length >= 8 && PNG_SIG.every((b, i) => buf[i] === b);
    } catch {
      // a missing or unreadable file leaves ok false
    }
    if (!ok) bad.push(`${id}.png`);
  }
  expect(
    bad,
    "missing or invalid baseline screenshots (run: cd daemon && node e2e/capture-screenshots.mjs)",
  ).toEqual([]);
  const pngs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".png")) : [];
  expect(pngs.length, `baseline PNG count in ${dir}`).toBe(ids.length);
});

test("one connection indicator: the same words on every page and no flap on a drop", async ({ page }) => {
  test.setTimeout(120_000);
  const VOCAB = ["Connected", "Reconnecting...", "Offline"];
  await open(page, "home");
  const pill = page.locator("header #conn");
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText("Connected");

  await page.getByRole("button", { name: "This PC's screen" }).click();
  const winStatus = page.locator("#pwins .pwin-status");
  await expect(winStatus).toBeVisible();
  const winBefore = ((await winStatus.textContent()) || "").trim();

  await page.evaluate(() => {
    const el = globalThis.document.querySelector("#conn");
    globalThis.__connWords = [];
    new globalThis.MutationObserver(() => globalThis.__connWords.push(el.textContent)).observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });

  daemon.setDown(true);
  await expect(pill).toHaveText("Reconnecting...", { timeout: 15_000 });
  const words = await page.evaluate(() => globalThis.__connWords.slice());
  console.log("conn words after the drop:", JSON.stringify(words));
  expect(
    words.filter((w) => w !== "Reconnecting..."),
    `conn words after the drop: ${words.join(" | ")}`,
  ).toEqual([]);

  await expect
    .poll(async () => ((await winStatus.textContent()) || "").trim(), {
      timeout: 15_000,
      message: "the desktop window status did not change when the daemon went down",
    })
    .not.toBe(winBefore);
  const shown = ((await winStatus.textContent()) || "").trim();
  expect(VOCAB, `desktop window status "${shown}" is not one of ${VOCAB.join(", ")}`).toContain(shown);

  for (const id of ["home", "thispc", "sessions", "running"]) {
    await page.locator(`#nav a[data-page="${id}"]`).click();
    await expect(page.locator(`#page-${id}`)).toBeVisible();
    await expect(pill).toHaveText("Reconnecting...");
    const bare = await page.evaluate(() => {
      const rx =
        /^(?:[A-Za-z][A-Za-z ]{0,12}:\s*)?(connected|offline|disconnected|online|reconnecting)[.!]{0,3}$/i;
      const out = [];
      for (const el of globalThis.document.querySelectorAll("#pages *")) {
        if (el.children.length) continue;
        if (el.closest("[hidden]")) continue;
        const box = el.getBoundingClientRect();
        if (!box.width && !box.height) continue;
        const text = (el.textContent || "").trim();
        if (rx.test(text)) out.push(text);
      }
      return out;
    });
    expect(bare, `${id}: ${bare.join("; ")}`).toEqual([]);
    const joined = await page.locator(`#page-${id}`).innerText();
    const m = joined.match(/\b(?:app|page|desktop):\s*(?:connected|offline)\b/i);
    expect(m ? m[0] : "", `${id}: ${m ? m[0] : ""}`).toBe("");
  }

  daemon.setDown(false);
  await expect(pill).toHaveText("Connected", { timeout: 30_000 });
  await expect(page.locator("body")).toHaveClass(/online/);
});

test("the messages card loads, empties, fails and retries after a re-render", async ({ page }) => {
  test.setTimeout(90_000);
  daemon.setMode("sms.threads", "hold");
  await page.goto(`${daemon.url}/#go=messages`);
  await expect(page.locator("body")).toHaveClass(/online/);
  const list = page.locator("#smsList");
  await expect(list, "messages loading").toHaveAttribute("data-state", "loading");
  await expect(list.locator(".empty"), "messages loading wording").toHaveText("Loading…");
  daemon.setMode("sms.threads", "ok");
  await expect(list.locator(".item")).toHaveCount(1);
  expect(await list.getAttribute("data-state")).toBeNull();

  daemon.setMode("sms.threads", "empty");
  await page.locator("#page-messages").getByRole("button", { name: "Refresh" }).click();
  await expect(list, "messages empty").toHaveAttribute("data-state", "empty");
  await expect(list.locator(".empty"), "messages empty wording").toHaveText("No conversations on the phone.");
  await expect(retry(page, "#smsList")).toBeVisible();

  daemon.setMode("sms.threads", "error");
  await page.locator("#page-messages").getByRole("button", { name: "Refresh" }).click();
  await expect(list, "messages error").toHaveAttribute("data-state", "error");
  await expect(list.locator(".empty"), "messages error wording").toContainText("Could not load this.");
  await expect(retry(page, "#smsList")).toBeEnabled();

  // A second error paint replaces the note and the button: the retry handler must not go with them.
  await page.locator("#page-messages").getByRole("button", { name: "Refresh" }).click();
  await expect(list, "messages error again").toHaveAttribute("data-state", "error");
  const stale = await retry(page, "#smsList").elementHandle();
  const before = daemon.requests("sms.threads");
  daemon.setMode("sms.threads", "ok");
  await retry(page, "#smsList").click();
  await expect
    .poll(() => daemon.requests("sms.threads"), {
      message: "the messages retry did not re-issue sms.threads",
    })
    .toBeGreaterThan(before);
  await expect(list.locator(".item"), "the list did not render after the retry").toHaveCount(1);
  expect(await list.getAttribute("data-state")).toBeNull();
  expect(
    await stale.evaluate((el) => el.isConnected),
    "the clicked Retry node should have been replaced",
  ).toBe(false);
});

test("the calls card empties, fails and retries", async ({ page }) => {
  await open(page, "calls");
  const list = page.locator("#callLog");
  await expect(list.locator(".item")).toHaveCount(1);

  daemon.setMode("calls.log", "empty");
  await page.locator("#page-calls").getByRole("button", { name: "Refresh" }).click();
  await expect(list, "calls empty").toHaveAttribute("data-state", "empty");
  await expect(list.locator(".empty"), "calls empty wording").toHaveText("No calls on the phone.");

  daemon.setMode("calls.log", "error");
  await retry(page, "#callLog").click();
  await expect(list, "calls error").toHaveAttribute("data-state", "error");
  await expect(list.locator(".empty"), "calls error wording").toContainText("Could not load this.");

  const before = daemon.requests("calls.log");
  daemon.setMode("calls.log", "ok");
  await retry(page, "#callLog").click();
  await expect.poll(() => daemon.requests("calls.log")).toBeGreaterThan(before);
  await expect(list.locator(".item"), "the list did not render after the retry").toHaveCount(1);
  expect(await list.getAttribute("data-state")).toBeNull();
});

test("the photos grid empties, fails and retries", async ({ page }) => {
  await open(page, "photos");
  const grid = page.locator("#photoGrid");
  await expect(grid.locator(".photo")).toHaveCount(1);

  daemon.setMode("photos.list", "empty");
  await page.locator("#page-photos").getByRole("button", { name: "Refresh" }).click();
  await expect(grid, "photos empty").toHaveAttribute("data-state", "empty");
  await expect(grid.locator(".empty"), "photos empty wording").toHaveText("No photos on the phone.");

  daemon.setMode("photos.list", "error");
  await retry(page, "#photoGrid").click();
  await expect(grid, "photos error").toHaveAttribute("data-state", "error");
  await expect(grid.locator(".empty"), "photos error wording").toContainText("Could not load this.");

  const before = daemon.requests("photos.list");
  daemon.setMode("photos.list", "ok");
  await retry(page, "#photoGrid").click();
  await expect.poll(() => daemon.requests("photos.list")).toBeGreaterThan(before);
  await expect(grid.locator(".photo"), "the grid did not render after the retry").toHaveCount(1);
  expect(await grid.getAttribute("data-state")).toBeNull();
});

test("the notifications card empties, fails and retries", async ({ page }) => {
  await open(page, "notifications");
  const list = page.locator("#notifList");
  await expect(list.locator(".notif")).toHaveCount(1);

  daemon.setMode("notif.list", "empty");
  await page.locator("#page-notifications").getByRole("button", { name: "Refresh" }).click();
  await expect(list, "notifications empty").toHaveAttribute("data-state", "empty");
  await expect(list.locator(".empty"), "notifications empty wording").toHaveText(
    "No notifications on the phone.",
  );

  daemon.setMode("notif.list", "error");
  await retry(page, "#notifList").click();
  await expect(list, "notifications error").toHaveAttribute("data-state", "error");
  await expect(list.locator(".empty"), "notifications error wording").toContainText("Could not load this.");

  const before = daemon.requests("notif.list");
  daemon.setMode("notif.list", "ok");
  await retry(page, "#notifList").click();
  await expect.poll(() => daemon.requests("notif.list")).toBeGreaterThan(before);
  await expect(list.locator(".notif"), "the list did not render after the retry").toHaveCount(1);
  expect(await list.getAttribute("data-state")).toBeNull();
});

test("the sessions page shows loading, empty and error, and Retry asks again", async ({ page }) => {
  test.setTimeout(90_000);
  daemon.setMode("history_list", "hold");
  await open(page, "sessions");
  const list = page.locator("#page-sessions .list");
  await expect(list, "sessions loading").toHaveAttribute("data-state", "loading");

  daemon.setMode("history_list", "ok");
  await expect(list.locator(".item")).toHaveCount(3);

  daemon.setMode("history_list", "empty");
  await page.locator("#nav a[data-page='sessions']").click();
  await expect(list, "sessions empty").toHaveAttribute("data-state", "empty");
  await expect(list.locator(".empty"), "sessions empty wording").toHaveText(
    "No saved conversations on this PC yet.",
  );

  daemon.setMode("history_list", "error");
  await page.locator("#nav a[data-page='sessions']").click();
  await expect(list, "sessions error").toHaveAttribute("data-state", "error");
  await expect(list.locator(".empty"), "sessions error wording").toContainText("history failed");

  daemon.setMode("history_list", "ok");
  const before = daemon.requests("history_list");
  await retry(page, "#page-sessions .list").click();
  await expect
    .poll(() => daemon.requests("history_list"), { message: "the sessions retry did not ask again" })
    .toBeGreaterThan(before);
  await expect(list.locator(".item")).toHaveCount(3);
  expect(await list.getAttribute("data-state")).toBeNull();
});

test("the running page shows loading and error, and its empty session list", async ({ page }) => {
  test.setTimeout(90_000);
  daemon.setMode("running_state", "hold");
  await open(page, "running");
  const col = page.locator("#page-running .col").first();
  await expect(col, "running loading").toHaveAttribute("data-state", "loading");

  daemon.setMode("running_state", "ok");
  const panel = page.locator("#page-running");
  await expect(panel).not.toHaveText(/Nothing is running/);
  await expect(panel.getByText("claude")).toBeVisible();

  daemon.setMode("running_state", "error");
  await panel.getByRole("button", { name: "Refresh" }).click();
  await expect(col, "running error").toHaveAttribute("data-state", "error");

  daemon.setMode("running_state", "ok");
  const before = daemon.requests("running_state");
  await retry(page, "#page-running .col").click();
  await expect
    .poll(() => daemon.requests("running_state"), { message: "the running retry did not ask again" })
    .toBeGreaterThan(before);
  await expect(col).not.toHaveAttribute("data-state", "error");
  expect(await col.getAttribute("data-state")).toBeNull();

  daemon.setMode("running_state", "empty");
  await panel.getByRole("button", { name: "Refresh" }).click();
  await expect(panel.getByText("Nothing is running.")).toBeVisible();
  expect(await col.getAttribute("data-state")).toBeNull();
});

test("a page keeps the shared connection words, disables retry while down and re-fetches on reconnect", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await open(page, "messages");
  const list = page.locator("#smsList");
  await expect(list.locator(".item")).toHaveCount(1);

  daemon.setMode("sms.threads", "error");
  await page.locator("#page-messages").getByRole("button", { name: "Refresh" }).click();
  await expect(list, "messages error").toHaveAttribute("data-state", "error");
  await expect(retry(page, "#smsList")).toBeEnabled();

  daemon.setDown(true);
  await expect(page.locator("#conn")).toHaveText("Reconnecting...", { timeout: 15_000 });
  await expect(retry(page, "#smsList"), "the retry must be off while the socket is down").toBeDisabled();
  const text = await page.locator("#page-messages").innerText();
  expect(text, "messages printed its own connection words").not.toMatch(/reconnecting|offline|disconnected/i);

  daemon.setMode("sms.threads", "ok");
  daemon.setDown(false);
  await expect(page.locator("#conn")).toHaveText("Connected", { timeout: 30_000 });
  await expect(list.locator(".item")).toHaveCount(1);
  expect(await list.getAttribute("data-state")).toBeNull();
});
