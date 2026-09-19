// Browser smoke test: loads the BUILT single-file ../index.html in real chromium, injects
// a fixture arm catalog as window.__ARMS__, and asserts it boots and renders without errors.
// This catches what the golden test cannot: ESM strict-mode breakage (the chart/bootstrap
// were sloppy-mode <script> IIFEs, now strict modules), module load-order, and DOM wiring.
//
// Gated behind SMOKE=1 so the default `npm test` stays hermetic (no browser). Run: `npm run smoke`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { dualRuns, workloadFreeRun } from "./fixture";

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

  // A run with no foreground workload (`ops: {}`) drops the whole Workload Latency section.
  // render_body's gate is unit-tested in body.test.ts; what this adds is that the chart layer
  // copes with the op charts and .optbl targets simply not being in the DOM — redraw() and
  // refreshTables() look them up by selector — and that the Restore side still draws.
  it("renders a workload-free run with no latency section and no errors", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push("pageerror: " + e.message));
    page.on("console", (m: any) => {
      if (m.type() === "error") errors.push("console.error: " + m.text());
    });

    const payload = Buffer.from(JSON.stringify({ runs: [workloadFreeRun()] }), "utf8").toString("base64url");
    await page.goto(BUILT + "#" + payload, { waitUntil: "load" });
    await page.waitForSelector(".report", { timeout: 5000 });

    const counts = await page.evaluate(() => ({
      opCharts: document.querySelectorAll(".chart[data-op]").length,
      opTables: document.querySelectorAll(".optbl").length,
      latCtrls: document.querySelectorAll("[data-pct],[data-qps],[data-scale]").length,
      headers: Array.from(document.querySelectorAll(".ctrl.header .htitle")).map((e) => e.textContent),
      dlLines: document.querySelectorAll(".dlchart svg path").length,
      dlTicks: document.querySelectorAll(".dlchart svg text").length,
      dlTables: document.querySelectorAll("table.tbl.dlt").length,
      remote: document.querySelectorAll(".chart[data-remote] svg").length,
      dashes: (document.querySelector(".dash")!.textContent!.match(/–/g) || []).length,
    }));

    expect(errors, errors.join("\n")).toEqual([]);
    expect(counts.opCharts).toBe(0);
    expect(counts.opTables).toBe(0);
    expect(counts.latCtrls).toBe(0);
    expect(counts.headers).toEqual(["Restore Progress"]);
    expect(counts.dlLines).toBeGreaterThan(0);   // download curve + MB/s overlay
    expect(counts.dlTicks).toBeGreaterThan(0);   // ...on a real axis
    expect(counts.dlTables).toBe(3);             // throughput / progress / distribution
    expect(counts.remote).toBe(1);               // per-node skew chart
    expect(counts.dashes).toBe(0);               // nothing rendered as "no value"

    // The global controls still drive the remaining charts.
    await page.click("[data-xmode='pct']");
    await page.waitForTimeout(50);
    expect(errors, "errors after interaction:\n" + errors.join("\n")).toEqual([]);

    await page.close();
  }, 30000);
});
