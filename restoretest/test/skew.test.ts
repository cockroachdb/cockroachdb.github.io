// Node-download skew is measured against the run's BASELINE sample — the tick with the greatest
// across-node TOTAL remote MB — not the first sample. The restore links files in as it goes, so
// remote bytes rise through link-in before the download drives them down: the first tick catches
// link-in mid-flight (and can be all zeros, which would pin every ratio to 0).
import { describe, it, expect } from "vitest";
import { parse_run } from "../src/compute/ingest";
import { analyze } from "../src/compute/analyze";
import { download_tables } from "../src/render/tables";
import { _num } from "../src/format/format";

// A run whose per-node remote MB ramps up (link-in) before draining. `remote` is per tick:
// [node0, node1]. Download % is a plain ramp to 100% so the rest of the report has something.
function body(remote: number[][]) {
  const n = remote.length;
  const pct = remote.map((_, i) => +((i / (n - 1)) * 100).toFixed(1));
  const cols = [0, 1].map((node) => remote.map((row) => row[node]));
  return {
    v: 2,
    elapsed: remote.map((_, i) => i * 30),
    metadata: { test: "restore/online/nodes=2/cpus=8", timestamp: "260101-000000" },
    download: { pct, mbps: remote.map((_, i) => (i ? 50 : 0)), node_remote_mb: cols },
    ops: { newOrder: { qps: remote.map(() => 10), p50: remote.map(() => 1), p95: remote.map(() => 2), p99: remote.map(() => 3) } },
  };
}
// Peak total is at tick 1: 300+100 = 400 (mean 200, spread 200 -> 100% skew). At tick 0 only a
// sliver has been linked in, and its spread over its own mean would read 200%.
const RAMP = [[10, 0], [300, 100], [200, 60], [100, 20], [0, 0]];
const arm = (label: string, runs: unknown[]) =>
  ({ label, name: label, ts: "260101-000000", ab: null, settings: {}, test: "restore/online/nodes=2/cpus=8", runs });
const skewRow = (html: string) => /<tr><td class="l stage[^"]*">initial skew<\/td>(.*?)<\/tr>/.exec(html)?.[1] ?? "";

describe("baseline sample", () => {
  it("is the tick with the greatest across-node total, not the first", () => {
    const s: any[] = parse_run(body(RAMP));
    expect(s.map((x) => !!x.rbase)).toEqual([false, true, false, false, false]);
  });

  it("scales the skew ratio by the baseline mean", () => {
    const s: any[] = parse_run(body(RAMP));
    // spread / 200: 10/200, 200/200, 140/200, 80/200, 0/200. Scaling by the FIRST tick's mean
    // (5) instead would put the peak at 40x.
    expect(s.map((x) => x.rratio)).toEqual([0.05, 1, 0.7, 0.4, 0]);
  });

  it("is the first tick when remote bytes only ever fall", () => {
    const s: any[] = parse_run(body([[1000, 600], [500, 300], [0, 0]]));
    expect(s.map((x) => !!x.rbase)).toEqual([true, false, false]);
    expect(s.map((x) => x.rratio)).toEqual([0.5, 0.25, 0]);
  });

  it("survives a first tick with nothing linked in yet", () => {
    // The old first-tick baseline was 0 here, which pinned every ratio to 0 for the whole run.
    const s: any[] = parse_run(body([[0, 0], [800, 400], [200, 100], [0, 0]]));
    expect(s.map((x) => !!x.rbase)).toEqual([false, true, false, false]);
    expect(s.map((x) => x.rratio)).toEqual([0, 400 / 600, 100 / 600, 0]);
  });
});

describe("initial skew", () => {
  it("is the baseline sample's spread over its mean, per run", () => {
    const ctx: any = analyze([arm("A", [body(RAMP), body([[0, 0], [900, 300], [0, 0]])])]);
    expect(ctx.series.agg.rInitSkewRuns.ctl).toEqual([100, 100]); // 200/200, 600/600
  });

  it("reports it in the progress-distribution table", () => {
    const html = download_tables(analyze([arm("A", [body(RAMP)])]));
    expect(skewRow(html)).toContain('<span class="pval">' + _num(100) + "</span>");
    // The first sample would have read 200% (spread 10 over mean 5).
    expect(skewRow(html)).not.toContain('<span class="pval">' + _num(200) + "</span>");
  });

  it("drops runs that carry no per-node columns", () => {
    const b: any = body(RAMP);
    b.download.node_remote_mb = [];
    expect(download_tables(analyze([arm("A", [b])]))).not.toContain("initial skew");
  });
});
