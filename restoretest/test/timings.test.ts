// The optional format additions: the `timings` milestone block and metadata.total_bytes.
// Covers what they add (progress-table milestone rows, whole-operation throughput rows, the
// details-table cluster/dataset rows), that the node count comes from the download columns
// rather than the opaque test name, and that everything degrades cleanly when absent.
import { describe, it, expect } from "vitest";
import { analyze } from "../src/compute/analyze";
import { prov_table, time_to_stall_table, mbps_table } from "../src/render/tables";

const GIB = 1024 * 1024 * 1024;
const TOTAL_BYTES = 300 * GIB; // -> 307200 MB
const NODES = 5;

// Download reaches 100% at el=90. The test NAME deliberately claims a different node count
// than the body carries — nothing may be parsed out of it.
function body(o: { timings?: unknown; totalBytes?: number; nodes?: number } = {}) {
  const nodes = o.nodes ?? NODES;
  const node_remote_mb: number[][] = [];
  for (let n = 0; n < nodes; n++) node_remote_mb.push([1000, 667, 333, 0, 0]);
  const b: any = {
    v: 2,
    elapsed: [0, 30, 60, 90, 120],
    metadata: { test: "restore/online/nodes=99/cpus=8", timestamp: "260101-000000" },
    download: { pct: [0, 33.3, 66.7, 100, 100], mbps: [null, 40, 50, 60, null], node_remote_mb },
    ops: { newOrder: { qps: [10, 10, 10, 10, 10], p50: [1, 2, 3, 4, 5], p95: [2, 3, 4, 5, 6], p99: [3, 4, 5, 6, 7] } },
  };
  if (o.totalBytes != null) b.metadata.total_bytes = o.totalBytes;
  if (o.timings) b.timings = o.timings;
  return b;
}
const TIMINGS = { available: 15, functional: 30, healthy: 60, restored: 90 };
const arm = (label: string, runs: unknown[]) => ({ label, name: label, ts: "260101-000000", ab: null, settings: {}, test: "restore/online/nodes=99/cpus=8", runs });
const full = () => analyze([arm("A", [body({ timings: TIMINGS, totalBytes: TOTAL_BYTES })])]);
const bare = () => analyze([arm("A", [body()])]);
// Row labels of a rendered download table, in render order.
const rowLabels = (html: string) =>
  Array.from(html.matchAll(/<td class="l stage[^"]*">(.*?)<\/td>/g)).map((m) => m[1]);

describe("node count", () => {
  it("comes from the per-node download columns, never the test name", () => {
    expect(full().nodes).toBe(NODES); // the name claims nodes=99
    expect(analyze([arm("A", [body({ nodes: 3 })])]).nodes).toBe(3);
  });

  it("is null when the run carries no per-node columns", () => {
    const b = body();
    b.download.node_remote_mb = [];
    expect(analyze([arm("A", [b])]).nodes).toBe(null);
  });
});

describe("timings -> progress rows", () => {
  it("emits a row per usability milestone, but not for `restored`", () => {
    const ctx: any = full();
    expect(ctx.milestones.map((r: any) => r.key)).toEqual(["available", "functional", "healthy"]);
    expect(ctx.milestones.map((r: any) => r.arms[0].v)).toEqual([15, 30, 60]);
  });

  it("interleaves milestones with the download-% rows in chronological order", () => {
    // available 15s, functional 30s, then 50% and healthy both at 60s, then 90%/100% at 90s.
    expect(rowLabels(time_to_stall_table(full()))).toEqual(
      ["available", "functional", "50%", "healthy", "90%", "100%"],
    );
  });

  it("drops the milestone rows entirely when no run reports them", () => {
    expect(analyze([arm("A", [body()])]).milestones).toEqual([]);
    expect(rowLabels(time_to_stall_table(bare()))).toEqual(["50%", "90%", "100%"]);
  });
});

describe("throughput rows", () => {
  it("leads with overall = total size / time-to-restored / node", () => {
    const ctx: any = full();
    expect(ctx.mbps_rows[0].key).toBe("overall");
    expect(ctx.mbps_rows[0].arms[0].v).toBeCloseTo(307200 / 90 / NODES, 6); // 682.67
  });

  it("adds a per-milestone effective rate over the same total size", () => {
    const byKey: any = {};
    (full() as any).mbps_rows.forEach((r: any) => (byKey[r.key] = r));
    expect(byKey.to_available.arms[0].v).toBeCloseTo(307200 / 15 / NODES, 6);
    expect(byKey.to_functional.arms[0].v).toBeCloseTo(307200 / 30 / NODES, 6);
    expect(byKey.to_healthy.arms[0].v).toBeCloseTo(307200 / 60 / NODES, 6);
  });

  it("keeps the disk rates, below the whole-operation rows", () => {
    expect((full() as any).mbps_rows.map((r: any) => r.key))
      .toEqual(["overall", "to_available", "to_functional", "to_healthy", "avg", "peak"]);
    // mbps readings are [40,50,60] with the first non-zero one dropped -> avg 55, peak 60.
    const byKey: any = {};
    (full() as any).mbps_rows.forEach((r: any) => (byKey[r.key] = r));
    expect(byKey.avg.arms[0].v).toBeCloseTo(55, 6);
    expect(byKey.peak.arms[0].v).toBeCloseTo(60, 6);
  });

  it("falls back to the 100% download crossing when `restored` is absent", () => {
    const t: any = { available: 15, functional: 30, healthy: 60 };
    const ctx: any = analyze([arm("A", [body({ timings: t, totalBytes: TOTAL_BYTES })])]);
    expect(ctx.mbps_rows[0].key).toBe("overall");
    expect(ctx.mbps_rows[0].arms[0].v).toBeCloseTo(307200 / 90 / NODES, 6);
  });

  it("drops the whole-operation rows without total_bytes, keeping the disk rates", () => {
    const ctx: any = analyze([arm("A", [body({ timings: TIMINGS })])]);
    expect(ctx.mbps_rows.map((r: any) => r.key)).toEqual(["avg", "peak"]);
    expect(ctx.milestones.length).toBe(3); // milestones don't need a size
  });

  it("renders per-node units in the cells and bare labels in the column", () => {
    const html = mbps_table(full());
    expect(rowLabels(html)).toEqual(["overall", "to available", "to functional", "to healthy", "avg disk", "peak disk"]);
    expect(html).toContain('<span class="unit">MB/s/node</span>');
  });
});

describe("details table", () => {
  it("shows the derived node count and the dataset size", () => {
    const html = prov_table(full());
    expect(html).toContain("nodes");
    expect(html).toContain("300 GB");
  });

  it("omits the size row when no run reports total_bytes", () => {
    expect(prov_table(bare())).not.toContain("data size");
  });

  it("omits the nodes row when no run carries per-node columns", () => {
    const b = body();
    b.download.node_remote_mb = [];
    expect(prov_table(analyze([arm("A", [b])]))).not.toMatch(/>nodes</);
  });
});
