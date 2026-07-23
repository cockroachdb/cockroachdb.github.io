// Sticky dashboard behavior (SMOKE-gated). Scrolling into the latency charts should pin the
// Restore header (top:0), shrink the progress graph to the compact strip and pin it below the
// header, and pin the Latency header below the compact graph.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { dualRuns } from "./fixture";

const RUN = !!process.env.SMOKE;
const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT = pathToFileURL(resolve(HERE, "../index.html")).href;
const HASH = "#" + Buffer.from(JSON.stringify({ runs: dualRuns() }), "utf8").toString("base64url");

(RUN ? describe : describe.skip)("sticky dashboard", () => {
  let browser: any, page: any;
  beforeAll(async () => {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ channel: "chrome" });
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(BUILT + HASH, { waitUntil: "load" });
    await page.waitForSelector(".report");
  });
  afterAll(async () => { if (browser) await browser.close(); });

  const rect = (sel: string) => page.evaluate((s: string) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), height: Math.round(r.height), stuck: el.classList.contains("stuck") };
  }, sel);

  it("full-height and not stuck at the top", async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(60);
    const g = await rect(".stick-graph");
    expect(g.stuck).toBe(false);
    expect(g.height).toBeGreaterThan(200); // full chart, not the compact strip
  });

  it("pins the arm bar to the top, the compact graph below it, then the control bar + Latency header", async () => {
    await page.evaluate(() => {
      const c = document.querySelector('.chart[data-op="newOrder"]');
      if (c) c.scrollIntoView();
    });
    await page.waitForTimeout(120);
    const arm = await rect(".armbar");
    const graph = await rect(".stick-graph");
    const gctrl = await rect(".stick-gctrl");
    const latency = await rect(".stick-latency");
    expect(arm.top).toBeLessThanOrEqual(1);                    // arm bar pinned to the very top
    // The compact graph pins directly under the arm bar (not flush to 0, not behind it).
    expect(Math.abs(graph.top - (arm.top + arm.height))).toBeLessThan(3);
    expect(graph.stuck).toBe(true);                            // collapsed to compact
    expect(graph.height).toBeLessThan(160);                    // ~110px strip
    expect(Math.abs(gctrl.top - (graph.top + graph.height))).toBeLessThan(3); // bar under the graph
    // The Latency header is the split ribbon's left half — pinned at the SAME level as the bar.
    expect(Math.abs(latency.top - gctrl.top)).toBeLessThan(2);
  });
});
