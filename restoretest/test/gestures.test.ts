// Plot mouse/keyboard gestures (SMOKE-gated). Verifies the redesigned model:
//   single-click empty area -> toggle summary <-> all-runs
//   double-click            -> cycle the arm(s) shown (was: reset zoom)
//   Escape                  -> reset zoom  (double-click no longer does)
// Pin/un-pin gestures are covered in hover.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { dualRuns } from "./fixture";

const RUN = !!process.env.SMOKE;
const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT = pathToFileURL(resolve(HERE, "../index.html")).href;
const HASH = "#" + Buffer.from(JSON.stringify({ runs: dualRuns() }), "utf8").toString("base64url");

(RUN ? describe : describe.skip)("plot gestures", () => {
  let browser: any, page: any;
  beforeAll(async () => {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ channel: "chrome" });
  });
  afterAll(async () => { if (browser) await browser.close(); });
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1400, height: 2200 } });
    await page.goto(BUILT + HASH, { waitUntil: "load" });
    await page.waitForSelector(".report");
    await page.click("[data-plot='all']");
    await page.waitForTimeout(100);
    await (await page.$('.chart[data-op="agg"]')).scrollIntoViewIfNeeded();
    await page.waitForTimeout(60);
  });
  afterEach(async () => { if (page) await page.close(); });

  const q = (sel: string) => page.evaluate((s: string) => document.querySelectorAll(s).length, sel);
  const aggScrub = () => page.$('.chart[data-op="agg"] .scrubhit');
  const armsShown = () => page.evaluate(() => {
    const s = new Set<string>();
    document.querySelectorAll(".rln[data-run]").forEach((p) => s.add((p.getAttribute("data-run") || "").split("#")[0]));
    return [...s].sort();
  });
  // A point in an empty band of the agg chart (not on any line).
  async function emptyPoint() {
    const b = await (await aggScrub()).boundingBox();
    return { x: b.x + b.width * 0.82, y: b.y + b.height * 0.42 };
  }

  it("single-click on empty area toggles summary <-> all-runs", async () => {
    expect(await q(".chart[data-op='agg'] .rln")).toBeGreaterThan(0); // all-runs: per-run lines
    const p = await emptyPoint();
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(280);                                   // click deferred ~220ms
    expect(await q(".chart[data-op='agg'] .rln")).toBe(0);           // -> summary: no per-run lines
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(280);
    expect(await q(".chart[data-op='agg'] .rln")).toBeGreaterThan(0); // -> back to all-runs
  });

  it("double-click cycles arms (and does not toggle summary)", async () => {
    expect(await armsShown()).toEqual(["ctl", "exp"]);
    const p = await emptyPoint();
    await page.mouse.click(p.x, p.y, { clickCount: 2 });
    await page.waitForTimeout(280);
    expect(await armsShown()).toEqual(["ctl"]);                       // both -> A
    await page.mouse.click(p.x, p.y, { clickCount: 2 });
    await page.waitForTimeout(280);
    expect(await armsShown()).toEqual(["exp"]);                       // A -> B
  });

  it("Escape resets zoom; double-click does not", async () => {
    const b = await (await aggScrub()).boundingBox();
    // Drag a horizontal band (elapsed mode is the default) to zoom.
    await page.mouse.move(b.x + b.width * 0.30, b.y + b.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.62, b.y + b.height * 0.5, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(80);
    expect(await q("body.zoomed")).toBe(1);                           // zoomed in
    // Double-click no longer un-zooms (it cycles arms) — still zoomed afterward.
    const p = await emptyPoint();
    await page.mouse.click(p.x, p.y, { clickCount: 2 });
    await page.waitForTimeout(120);
    expect(await q("body.zoomed")).toBe(1);
    // Escape resets the zoom.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    expect(await q("body.zoomed")).toBe(0);
  });
});
