// Browser smoke test: loads the BUILT single-file ../index.html in real chromium, injects
// a fixture arm catalog as window.__ARMS__, and asserts it boots and renders without errors.
// This catches what the golden test cannot: ESM strict-mode breakage (the chart/bootstrap
// were sloppy-mode <script> IIFEs, now strict modules), module load-order, and DOM wiring.
//
// Gated behind SMOKE=1 so the default `npm test` stays hermetic (no browser). Run: `npm run smoke`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { dualRuns } from "./fixture";

const RUN = !!process.env.SMOKE;
const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT = "file://" + resolve(HERE, "../index.html");

(RUN ? describe : describe.skip)("browser smoke (built index.html)", () => {
  let browser: any, chromium: any;
  beforeAll(async () => {
    ({ chromium } = await import("playwright"));
    browser = await chromium.launch({ channel: "chrome" });
  });
  afterAll(async () => {
    if (browser) await browser.close();
  });

  it("boots and renders the report with no page errors", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push("pageerror: " + e.message));
    page.on("console", (m: any) => {
      if (m.type() === "error") errors.push("console.error: " + m.text());
    });

    // Inject the fixture runs via the URL #fragment, exactly as the test does: a base64url'd
    // {runs} payload (decodePayload also accepts gzip, but plain JSON is fine). The inline
    // `window.__ARMS__=null` script rules out addInitScript, so the hash is the path.
    const payload = Buffer.from(JSON.stringify({ runs: dualRuns() }), "utf8").toString("base64url");
    await page.goto(BUILT + "#" + payload, { waitUntil: "load" });
    await page.waitForSelector(".report", { timeout: 5000 });

    // render_body ran (details/tables), and the interactive chart ran (.scrubhit is only
    // emitted by __runChart, not the static baked SVG).
    const counts = await page.evaluate(() => ({
      report: document.querySelectorAll(".report").length,
      tables: document.querySelectorAll("table.tbl").length,
      chartSvgs: document.querySelectorAll(".chart svg").length,
      scrubhits: document.querySelectorAll(".scrubhit").length,
      lines: document.querySelectorAll("svg .ln").length,
    }));

    expect(errors, errors.join("\n")).toEqual([]);
    expect(counts.report).toBe(1);
    expect(counts.tables).toBeGreaterThan(3);
    expect(counts.chartSvgs).toBeGreaterThan(3);
    expect(counts.scrubhits).toBeGreaterThan(0); // proves __runChart executed
    expect(counts.lines).toBeGreaterThan(0);

    // Exercise controls to confirm the state->redraw wire works without error: the x-axis
    // toggle, and a double-click (which now cycles the shown arm — the old button is gone).
    await page.click("[data-xmode='pct']");
    await page.mouse.dblclick(700, 300);
    await page.waitForTimeout(50);
    expect(errors, "errors after interaction:\n" + errors.join("\n")).toEqual([]);

    await page.close();
  }, 30000);
});
