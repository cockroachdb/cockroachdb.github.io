// Behavioral test for the unified hover model (SMOKE-gated; run via `npm run hover`).
// Asserts: (1) the vertical cursor is universal — present over empty plot AND over a run;
// (2) hovering a run bolds it across charts and relabels the cursor header with the run id;
// (3) the old floating .runtip chip is gone; (4) leaving the run clears the bold but keeps
// the cursor. Uses getPointAtLength to land exactly on a run's stroke.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { dualRuns } from "./fixture";

const RUN = !!process.env.SMOKE;
const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT = pathToFileURL(resolve(HERE, "../index.html")).href;
const HASH = "#" + Buffer.from(JSON.stringify({ runs: dualRuns() }), "utf8").toString("base64url");

(RUN ? describe : describe.skip)("unified hover", () => {
  let browser: any, page: any;
  beforeAll(async () => {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ channel: "chrome" });
    page = await browser.newPage({ viewport: { width: 1400, height: 2200 } });
    await page.goto(BUILT + HASH, { waitUntil: "load" });
    await page.waitForSelector(".report");
    await page.click("[data-plot='all']");
    await page.waitForTimeout(120);
    // The agg chart is below the fold; scroll it in so getScreenCTM / boundingBox return
    // on-viewport coordinates that page.mouse.move can actually reach.
    await (await page.$('.chart[data-op="agg"]')).scrollIntoViewIfNeeded();
    await page.waitForTimeout(60);
  });
  afterAll(async () => { if (browser) await browser.close(); });

  const aggScrub = () => page.$('.chart[data-op="agg"] .scrubhit');
  const q = (sel: string) => page.evaluate((s: string) => document.querySelectorAll(s).length, sel);

  // A screen point lying exactly on a run's stroke in the agg chart.
  async function pointOnRun() {
    return await page.evaluate(() => {
      const p: any = document.querySelector('.chart[data-op="agg"] .rlnhit');
      const pt = p.getPointAtLength(p.getTotalLength() * 0.5);
      const s = pt.matrixTransform(p.getScreenCTM());
      return { x: s.x, y: s.y, key: p.getAttribute("data-run") };
    });
  }

  it("no floating run tooltip exists anymore", async () => {
    expect(await q(".runtip")).toBe(0);
  });

  it("hovering a run: cursor stays, run bolds, header names the run", async () => {
    const rp = await pointOnRun();
    await page.mouse.move(rp.x, rp.y);
    await page.waitForTimeout(80);
    expect(await q("body.runhi")).toBe(1);                 // dim-others engaged
    expect(await q(".rln.hon")).toBeGreaterThan(0);        // this run bolded (across charts)
    expect(await q('.chart[data-op="agg"] .cursorlayer .scrub')).toBe(1); // cursor present over the run
    const head = await page.evaluate(() =>
      document.querySelector('.chart[data-op="agg"] .curhead')?.textContent || "");
    expect(head).toMatch(/run /);                          // run id moved into the cursor header
    expect(await q(".runtip")).toBe(0);                    // still no floating chip
  });

  it("the cursor is synced across charts while hovering a run", async () => {
    // A different chart (a per-op latency chart) should also carry the vertical cursor.
    const scrubsElsewhere = await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll(".cursorlayer").forEach((l) => { if (l.querySelector(".scrub")) n++; });
      return n;
    });
    expect(scrubsElsewhere).toBeGreaterThan(1);
  });

  it("leaving the run clears the bold but keeps the cursor", async () => {
    const box = await (await aggScrub()).boundingBox();
    await page.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.42); // empty band
    await page.waitForTimeout(80);
    expect(await q("body.runhi")).toBe(0);                 // no run isolated
    expect(await q(".rln.hon")).toBe(0);
    expect(await q('.chart[data-op="agg"] .cursorlayer .scrub')).toBe(1); // cursor still universal
    const head = await page.evaluate(() =>
      document.querySelector('.chart[data-op="agg"] .curhead')?.textContent || "");
    expect(head).not.toMatch(/run /);                      // header back to plain x readout
  });

  const armsShown = () => page.evaluate(() => {
    const s = new Set<string>();
    document.querySelectorAll(".rln[data-run]").forEach((p) => s.add((p.getAttribute("data-run") || "").split("#")[0]));
    return [...s];
  });

  it("clicking a run pins it: isolation survives moving off the line, no arm-cycle", async () => {
    const rp = await pointOnRun();
    await page.mouse.click(rp.x, rp.y);
    await page.waitForTimeout(280);                         // click is deferred ~220ms (dblclick guard)
    // Move well off any run line — a transient hover would clear here; a pin must persist.
    const box = await (await aggScrub()).boundingBox();
    await page.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.42);
    await page.waitForTimeout(80);
    expect(await q("body.runhi")).toBe(1);                  // still isolated with the pointer off the run
    expect(await q(".rln.hon")).toBeGreaterThan(0);         // pinned run stays bold
    expect(await q('.chart[data-op="agg"] .cursorlayer .scrub')).toBe(1);
    const head = await page.evaluate(() =>
      document.querySelector('.chart[data-op="agg"] .curhead')?.textContent || "");
    expect(head).toMatch(/run /);                           // cursor still labels the pinned run at the new x
    // A click that pins must NOT also cycle arm visibility — both arms' runs still present.
    const arms = await armsShown();
    expect(arms).toContain("ctl");
    expect(arms).toContain("exp");
  });

  it("clicking again un-pins", async () => {
    const box = await (await aggScrub()).boundingBox();
    await page.mouse.click(box.x + box.width * 0.82, box.y + box.height * 0.42); // plain click, empty area
    await page.waitForTimeout(280);
    expect(await q("body.runhi")).toBe(0);
    expect(await q(".rln.hon")).toBe(0);
    expect(await armsShown()).toContain("exp");             // still no arm-cycle side effect
  });
});
