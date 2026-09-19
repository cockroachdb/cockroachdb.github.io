// Section gating in render_body: the Workload Latency half is emitted only when the run set
// actually carries latency/tps samples. A producer that drives no foreground workload emits
// `ops: {}` (summary_report_spec.md §1), and without the gate the section still renders six
// blank plots on a fabricated axis, a metric toggle bar that moves nothing, and six tables of
// "–". The Restore half must be unaffected — and so must the ordinary populated report.
import { describe, it, expect } from "vitest";
import { analyze } from "../src/compute/analyze";
import { render_body } from "../src/render/body";
import { soloArmsNew, workloadFreeRun } from "./fixture";

const arm = (label: string, runs: unknown[]) =>
  ({ label, name: label, ts: "260301-091500", ab: null, settings: {},
     test: "restore/online/nodes=5/cpus=8", runs });

const count = (html: string, re: RegExp) => (html.match(re) || []).length;

const workloadFree = () => render_body(analyze([arm("A", [workloadFreeRun()])]));
const populated = () => render_body(analyze(soloArmsNew()));

describe("workload-free run (ops: {})", () => {
  it("omits the whole Workload Latency section", () => {
    const html = workloadFree();
    expect(html).not.toContain("Workload Latency");
    expect(html).not.toContain("Transaction Latency");   // the per-op headings
    expect(count(html, /class='optbl'/g)).toBe(0);
    expect(count(html, /class='chart' data-op=/g)).toBe(0);
    expect(html).not.toContain("sec-sep");               // and the rule above it
  });

  it("drops the controls that only drive the op charts, keeping the global ones", () => {
    const html = workloadFree();
    expect(html).not.toContain("data-pct=");             // p50/p95/p99
    expect(html).not.toContain("data-qps");              // tps
    expect(html).not.toContain("data-scale=");           // linear/log
    expect(html).toContain("data-xmode=");               // elapsed / % downloaded
    expect(html).toContain("data-unzoom");
  });

  it("renders the Restore section in full", () => {
    const html = workloadFree();
    expect(html).toContain("Restore Progress");
    expect(html).toContain("class='chart dlchart'");     // progress chart (MB/s overlay included)
    expect(html).toContain("Progress Distribution");     // per-node skew chart
    expect(html).toContain("data-remote='1'");
    // All three download tables, and the milestone the run reported.
    expect(html).toContain(">throughput<");
    expect(html).toContain(">Progress<");
    expect(html).toContain(">progress distribution<");
    expect(html).toContain("available");
    expect(html).toContain("100% restored");
  });
});

describe("a run with a workload", () => {
  it("keeps the latency section, one chart + table per op", () => {
    const html = populated();
    expect(html).toContain("Workload Latency");
    expect(count(html, /class='chart' data-op=/g)).toBe(6);
    expect(count(html, /class='optbl'/g)).toBe(6);
    expect(html).toContain("data-pct='p50'");
    expect(html).toContain("Restore Progress");
  });

  it("keeps it when only SOME arm of the set ran a workload", () => {
    const mixed = analyze([soloArmsNew()[0], arm("B", [workloadFreeRun()])]);
    expect(render_body(mixed)).toContain("Workload Latency");
  });
});
