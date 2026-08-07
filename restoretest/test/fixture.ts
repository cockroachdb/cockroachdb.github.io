// Deterministic synthetic fixtures. The golden test feeds the SAME underlying data to the
// OLD pre-refactor CORE (old row/columnar body) and the NEW compute layer (v:2 body), so any
// divergence is a real behavior change. `*Runs` exports are the flat run lists (with metadata)
// the browser tests and the runsToSets unit test consume. We avoid Math.random for repro.

const REAL_OPS = ["newOrder", "payment", "orderStatus", "delivery", "stockLevel"];

// Tiny deterministic PRNG (mulberry32).
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RunData {
  els: number[];
  download: { pct: number; mbps: number }[];
  remote: number[][]; // per-tick: [node0, node1, ...]
  samples: Record<string, { qps: number; p50: number; p95: number; p99: number }[]>;
}

// One run's raw numbers on a single elapsed clock (download rises 0->100 by ~el=90 then
// steady; latency bumps mid-download; per-node remote-MB decays to 0).
function makeRunData(seed: number, latScale: number, nodes: number): RunData {
  const r = rng(seed);
  const els: number[] = [];
  for (let el = 0; el <= 150; el += 15) els.push(el);

  const download = els.map((el) => ({
    pct: +Math.min(100, (el / 90) * 100).toFixed(1),
    mbps: +(el === 0 ? 0 : 40 + 20 * r()).toFixed(2),
  }));

  const remote = els.map((el) => {
    const remainFrac = Math.max(0, 1 - el / 90);
    const row: number[] = [];
    for (let n = 0; n < nodes; n++) row.push(+(1000 * remainFrac * (0.8 + 0.4 * r())).toFixed(1));
    return row;
  });

  const samples: RunData["samples"] = {};
  REAL_OPS.forEach((op, oi) => {
    samples[op] = els.map((el) => {
      const pct = Math.min(100, (el / 90) * 100);
      const bump = 1 + 1.5 * Math.sin((pct / 100) * Math.PI);
      const base = latScale * (1 + oi * 0.3) * bump;
      const p50 = Math.round(base * (10 + 4 * r()));
      const p95 = Math.round(p50 * (2 + 0.5 * r()));
      const p99 = Math.round(p95 * (1.3 + 0.4 * r()));
      const qps = Math.round(200 + 80 * r());
      return { qps, p50, p95, p99 };
    });
  });

  return { els, download, remote, samples };
}

// OLD body: row-form [el,pct,mbps] / [el,qps,p50,p95,p99] / [el,node0,...]; v:2 transposes.
function toOldBody(d: RunData, columnar: boolean) {
  const download = d.els.map((el, i) => [el, d.download[i].pct, d.download[i].mbps]);
  const node_remote_mb = d.els.map((el, i) => [el, ...d.remote[i]]);
  const samples: Record<string, number[][]> = {};
  for (const op of REAL_OPS) {
    samples[op] = d.els.map((el, i) => {
      const s = d.samples[op][i];
      return [el, s.qps, s.p50, s.p95, s.p99];
    });
  }
  if (!columnar) return { download, node_remote_mb, samples };
  const cols = (rows: number[][]) => {
    if (!rows.length) return [];
    const out: number[][] = [];
    for (let c = 0; c < rows[0].length; c++) out.push(rows.map((row) => row[c]));
    return out;
  };
  const sc: Record<string, number[][]> = {};
  for (const op of REAL_OPS) sc[op] = cols(samples[op]);
  return { v: 2, download: cols(download), node_remote_mb: cols(node_remote_mb), samples: sc };
}

// The optional format additions: metadata.total_bytes + the body-level `timings` milestones.
// Only the flat-run builders (dualRuns/soloRuns) emit these — the golden catalogs stay on the
// pre-addition body so the frozen oracle remains directly comparable.
// Sized to match the synthetic download: ~50 MB/s/node x 5 nodes x 90s ~= 22 GB. Keeping it
// consistent means the rendered table has the real-world ordering, where `restored` (which
// includes the ramp before the disk starts writing) sits just below `disk avg rate`.
export const TOTAL_BYTES = 20 * 1024 * 1024 * 1024; // 20 GiB
function runTimings(seed: number) {
  const r = rng(seed ^ 0x5eed);
  // Download reaches 100% at el=90 in makeRunData, so `restored` matches the pct crossing;
  // the usability milestones land before it, jittered per run so the stats have spread.
  return {
    available: +(10 + 6 * r()).toFixed(1),
    functional: +(28 + 8 * r()).toFixed(1),
    healthy: +(55 + 12 * r()).toFixed(1),
    restored: 90,
  };
}

// NEW v:2 body: one `elapsed` axis, named column arrays under download/ops.
function toNewBody(d: RunData, meta?: unknown, timings?: unknown) {
  const nodes = d.remote.length ? d.remote[0].length : 0;
  const node_remote_mb: number[][] = [];
  for (let n = 0; n < nodes; n++) node_remote_mb.push(d.remote.map((row) => row[n]));
  const ops: Record<string, unknown> = {};
  for (const op of REAL_OPS) {
    ops[op] = {
      qps: d.samples[op].map((s) => s.qps),
      p50: d.samples[op].map((s) => s.p50),
      p95: d.samples[op].map((s) => s.p95),
      p99: d.samples[op].map((s) => s.p99),
    };
  }
  const body: any = {
    v: 2,
    elapsed: d.els.slice(),
    download: {
      pct: d.download.map((x) => x.pct),
      mbps: d.download.map((x) => x.mbps),
      node_remote_mb,
    },
    ops,
  };
  if (meta) body.metadata = meta;
  if (timings) body.timings = timings;
  return body;
}

// Arm config: run params + shared provenance (identical for old & new so prov_details match).
interface ArmCfg {
  label: string;
  seed: number;
  latScale: number;
  nRuns: number;
  nodes: number;
  settings: Record<string, string>;
  ts: string;
  sha: string;
  dirty: boolean;
  buildTime: string;
  commit: string;
  branch: string;
}
function testName(c: ArmCfg) {
  return `restore/nodes=${c.nodes}/cpus=8`;
}
function shortVer(c: ArmCfg) {   // short build id, shown as-is (sha or sha-dirty)
  return `${c.sha}${c.dirty ? "-dirty" : ""}`;
}
function prov(c: ArmCfg) {
  return {
    label: c.label,
    name: `${testName(c)}/${c.label}`,
    ts: c.ts,
    ab: null,
    sha: c.sha,               // data_json still reads .sha
    version: shortVer(c),
    settings: c.settings,
    buildTime: c.buildTime,
    test: testName(c),
    commit: c.commit,
    branch: c.branch,
  };
}
function runMeta(c: ArmCfg) {
  return {
    test: testName(c),
    timestamp: c.ts,
    version: shortVer(c),
    built: c.buildTime,
    settings: c.settings,
    commit: c.commit,
    branch: c.branch,
    total_bytes: TOTAL_BYTES,
  };
}
function seeds(c: ArmCfg) {
  const out: number[] = [];
  for (let i = 0; i < c.nRuns; i++) out.push(c.seed + i * 101);
  return out;
}
function oldArm(c: ArmCfg) {
  const runs = seeds(c).map((s, i) => toOldBody(makeRunData(s, c.latScale, c.nodes), i === c.nRuns - 1));
  return { ...prov(c), runs };
}
function newArm(c: ArmCfg) {
  const runs = seeds(c).map((s) => toNewBody(makeRunData(s, c.latScale, c.nodes)));
  return { ...prov(c), runs };
}
function armRuns(c: ArmCfg) {
  const m = runMeta(c);
  return seeds(c).map((s) => toNewBody(makeRunData(s, c.latScale, c.nodes), m, runTimings(s)));
}

const A: ArmCfg = {
  label: "A", seed: 1000, latScale: 1.0, nRuns: 3, nodes: 5,
  settings: { "kv.range_split.by_load.enabled": "true" },
  ts: "260722-164502", sha: "abcdef0123456789", dirty: false,
  buildTime: "2026/07/20 12:00:00",
  commit: "A test build subject line that is somewhat long to exercise truncation",
  branch: "master",
};
const B: ArmCfg = {
  label: "B", seed: 5000, latScale: 1.15, nRuns: 3, nodes: 5,
  settings: { "kv.range_split.by_load.enabled": "false", "cluster.organization": "Cockroach Labs" },
  ts: "260722-171233", sha: "9876543210fedcba", dirty: true,
  buildTime: "2026/07/20 12:00:00",
  commit: "B test build subject line that is somewhat long to exercise truncation",
  branch: "my-feature-branch",
};
const SOLO: ArmCfg = {
  label: "A", seed: 2000, latScale: 1.0, nRuns: 2, nodes: 3,
  settings: { "kv.range_split.by_load.enabled": "true" },
  ts: "260722-164502", sha: "abcdef0123456789", dirty: false,
  buildTime: "2026/07/20 12:00:00",
  commit: "solo build subject line", branch: "master",
};

// Arm-object catalogs (top-level provenance + run bodies) for the golden test's analyze().
export function dualArms() { return [oldArm(A), oldArm(B)]; }
export function soloArms() { return [oldArm(SOLO)]; }
export function dualArmsNew() { return [newArm(A), newArm(B)]; }
export function soloArmsNew() { return [newArm(SOLO)]; }

// Flat run lists (v:2 bodies WITH metadata) — the {runs} payload the app/tests ingest.
export function dualRuns() { return armRuns(A).concat(armRuns(B)); }
export function soloRuns() { return armRuns(SOLO); }
