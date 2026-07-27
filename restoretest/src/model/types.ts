// The data model — the shapes that flow through the layers. During the faithful port the
// compute/render internals stay loosely typed (tsconfig strict:false), so these interfaces
// are documentation-grade and adopted incrementally: import them at seams as the code is
// tightened. They capture the payload the report ingests, the parsed domain model, and the
// analyze() output that the render + chart layers consume.

// ---- Raw payload (what analyze() ingests) ----
//
// The report is driven by a flat list of RawRuns (each a summary_report.json). The UI groups
// them into "run sets" (Arm objects, below) by identity — see app/runsets.ts. See
// summary_report_spec.md for the wire format.

/** Per-run identity + provenance. Grouping key = test + timestamp + arm. */
export interface RunMetadata {
  test: string;
  /** invocation stamp "yymmdd-HHMMSS" — shared by every run of a set. */
  timestamp: string;
  /** short build id shown as-is: tag / sha / sha-dirty. */
  version?: string;
  /** build time, display-only string. */
  built?: string;
  settings?: Record<string, string>;
  /** 'a'/'b' — only when one invocation emits an A/B pair sharing the timestamp. */
  arm?: string;
  commit?: string;
  branch?: string;
}

/** A summary_report.json body (v:2 columnar). One shared `elapsed` axis; every value array
 *  is `elapsed.length` long, `null` where a series has no reading at that tick. */
export interface RawRun {
  v?: number;
  metadata?: RunMetadata;
  elapsed?: number[];
  download?: {
    pct?: (number | null)[];
    mbps?: (number | null)[];
    /** per-node MB remaining — one array per node, each aligned to `elapsed`. */
    node_remote_mb?: (number | null)[][];
  };
  ops?: Record<string, {
    qps?: (number | null)[];
    p50?: (number | null)[];
    p95?: (number | null)[];
    p99?: (number | null)[];
  }>;
}

/** A run set: runs sharing an identity, rendered as one arm (ctl/exp) of a comparison.
 *  Synthesized from grouped runs' metadata by app/runsets.ts. */
export interface Arm {
  label: string;
  name: string;
  /** invocation stamp "yymmdd-HHMMSS" (metadata.timestamp). */
  ts: string | null;
  /** 'a'/'b' (metadata.arm), else null. */
  ab: string | null;
  /** slot index in the current comparison (0=A/ctl, 1=B/exp, 2=C), set by the selector so the
   *  renderer can color each arm by slot regardless of how many lower slots are empty. */
  role?: number;
  sha?: string | null;
  dirty?: boolean;
  /** the set's --start-setting map; the report diffs the chosen pair itself. */
  settings?: Record<string, string>;
  buildTime?: string | null;
  test?: string | null;
  commit?: string | null;
  branch?: string | null;
  runs: RawRun[];
}

// ---- Parsed domain model (parse_run output) ----

/** One time sample: latencies + qps per op, plus the interpolated download-progress
 *  fields and per-node remote-MB reductions that ride on the same cadence. */
export interface Sample {
  el: number; // elapsed seconds
  pct: number | null; // download fraction 0..1
  lat: Record<string, number>; // "<op> <metric>" -> ms  (see LK)
  qps: Record<string, number>; // op -> qps
  ctx: Record<string, unknown>;
  mbps?: number | null;
  rmin?: number;
  rmean?: number;
  rmax?: number;
  rdelta?: number;
  rratio?: number;
}

/** A run is its sorted sample series. */
export type Run = Sample[];

// ---- Statistics / cells ----

export interface Summary {
  n: number;
  median: number | null;
  q1: number | null;
  q3: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  std: number | null;
  vals: number[];
}

export interface CellStats {
  ctl: Summary;
  exp: Summary;
  U: number;
  p: number;
  method: "exact" | "normal" | "none";
  hl: number;
  hl_lo: number;
  hl_hi: number;
  ratio: number | null;
  delta_pct: number | null;
  delta_mean: number | null;
  delta_mean_pct: number | null;
  ctl_qps: number | null;
  exp_qps: number | null;
  n_samp: number | null;
  reliable: boolean;
  overlap: boolean;
  _q: number | null; // BH-FDR q (exploratory family)
}

export interface Cell {
  op: string;
  metric: string;
  stall: string;
  ctl: number[];
  exp: number[];
  stats: CellStats;
}

// ---- analyze() output — the render + chart layers' input ----

/** The full analysis context. Kept as `any`-friendly during the port; the field list here
 *  documents what render_body / the chart / data_json read. See compute/analyze.ts. */
export interface Ctx {
  cells: Record<string, Cell>;
  order: string[];
  dual: boolean;
  control_label: string;
  experiment_label: string | null;
  prov_ctl: Arm;
  prov_exp: Arm | { settings: Record<string, string> };
  prov_details: Array<[string, unknown]>;
  n_ctl: number;
  n_exp: number;
  neg_control: unknown;
  qps_status: unknown;
  confounds: string[];
  primary_conclusion: string | null;
  primary_keys: string[];
  timing: Record<string, unknown>;
  time_to_stall: unknown[];
  mbps_rows: unknown[];
  nodes: number | null;
  series: Record<string, unknown>; // op -> build_series() result
  xmax_el: number;
  refComplete: number;
  timeRows: Array<{ t?: number; special?: string; label: string }>;
  op_order: string[];
  chartData: Record<string, unknown>;
  labels: { ctl: string; exp: string };
}

// ---- Control state (chart `state`; persisted subset = CTRL_DEFAULTS keys) ----

export interface ControlState {
  p50: boolean;
  p95: boolean;
  p99: boolean;
  qps: boolean;
  scale: "linear" | "log";
  xmode: "elapsed" | "pct";
  plot: "avg" | "all" | string; // 'all' or a specific run key
  armMode: "both" | "A" | "B";
  // live-only (not persisted to the URL):
  solo?: unknown;
  range?: { start: number; end: number };
  rmin?: boolean;
  rmean?: boolean;
  rmax?: boolean;
  rratio?: boolean;
  rdelta?: boolean;
}
