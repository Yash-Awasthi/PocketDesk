// SPDX-License-Identifier: GPL-3.0-or-later
// The hub's pages against a fake daemon: pairing, the device table, the two-factor section, one
// live session, and an axe pass over the hub and settings pages.
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

for (const [id, name] of [
  ["home", "hub"],
  ["thispc", "settings"],
  ["sessions", "sessions"],
]) {
  test(`the ${name} page has no critical axe findings`, async ({ page }) => {
    await open(page, id);
    const results = await new AxeBuilder({ page }).include(`#page-${id}`).analyze();
    const critical = results.violations.filter((v) => v.impact === "critical");
    expect(
      critical.map((v) => ({ id: v.id, nodes: v.nodes.length })),
      JSON.stringify(critical, null, 2),
    ).toEqual([]);
  });
}
