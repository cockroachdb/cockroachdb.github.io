// Ingestion: parse a summary_report.json run into the per-run time series.
import { LK, LAT_METRICS } from "../model/constants";
import { _n, _ln } from "../util";

// --------------------------------------------------------------------------
// Ingestion: the per-run time series (from a summary_report.json `samples`)
// --------------------------------------------------------------------------

function qps_weighted_agg(lat, qps){
  var tot = 0.0;
  var acc = {p50:0.0, p95:0.0, p99:0.0};
  for (var op in qps){
    var q = qps[op];
    if (q === null || q === undefined || q <= 0) continue;
    tot += q;
    for (var mi=0;mi<LAT_METRICS.length;mi++){
      var m = LAT_METRICS[mi];
      var v = lat[LK(op,m)];
      if (v !== null && v !== undefined) acc[m] += q*v;
    }
  }
  if (tot <= 0) return null;
  var out: any = {}; LAT_METRICS.forEach(function(m){ out[m] = acc[m]/tot; });
  out.qps = tot;
  return out;
}

// parse_run consumes a v:2 summary_report.json body (see summary_report_spec.md):
//
//   { "v":2, "elapsed":[t...],
//     "download": { "pct":[...], "mbps":[...], "node_remote_mb":[[node0...],[node1...]] },
//     "ops":      { "<op>": { "qps":[...], "p50":[...], "p95":[...], "p99":[...] } } }
//
// Everything is column-major on ONE `elapsed` axis; every value array is elapsed.length long
// with `null` where a series has no reading. We build one Sample per elapsed tick. Download
// %/MB-s are then filled onto every sample by interpolation (holding the endpoints — the
// steady-state 100% tail), so % is defined at every tick even when download rode a coarser
// clock; when it shares the sample clock (the common case) the fill is exact. Per-node remote
// MB remaining is reduced across nodes to min/mean/max, the absolute spread (max-min), and the
// skew ratio = (max-min) / the run's BASELINE across-node mean — a fixed per-run baseline, so the
// ratio stays byte-independent yet decays to 0 as the download completes (instead of blowing up as
// the instantaneous mean approaches 0),
// INCLUDING nodes already at 0. The report emits only the real ops; the "agg" op (Overall
// Workload Latency) is derived here as the per-sample QPS-weighted mean.
function _at(col, i){ return (Array.isArray(col) && i < col.length) ? col[i] : null; }
function parse_run(run){
  if (!run || typeof run !== "object" || Array.isArray(run)) return [];
  var el = Array.isArray(run.elapsed) ? run.elapsed : [];
  if (!el.length) return [];
  var dl = (run.download && typeof run.download === "object") ? run.download : {};
  var ops = (run.ops && typeof run.ops === "object") ? run.ops : {};
  var pctCol = dl.pct, mbpsCol = dl.mbps;
  var nodeCols = Array.isArray(dl.node_remote_mb) ? dl.node_remote_mb : [];

  var samples = [];
  // The run's BASELINE sample: the tick with the greatest across-node TOTAL remote MB. The
  // restore links files in as it goes, so remote bytes RISE through link-in before the download
  // drives them back down — the first tick holds whatever was linked in by then (often near 0,
  // sometimes exactly 0, which would pin every ratio below to 0) and says nothing about the run.
  // The peak total is the moment the whole working set is known, so that is what the skew ratio
  // divides by, and what build_series measures each run's initial skew at.
  var baseSample: any = null, baseSum = null;
  for (var i=0;i<el.length;i++){
    var s: any = {el:+el[i], pct:null, lat:{}, qps:{}, ctx:{}};
    for (var op in ops){
      var o = ops[op] || {};
      var qps = _at(o.qps,i), p50 = _at(o.p50,i), p95 = _at(o.p95,i), p99 = _at(o.p99,i);
      if (qps != null) s.qps[op] = +qps;
      if (p50 != null) s.lat[LK(op,"p50")] = +p50;
      if (p95 != null) s.lat[LK(op,"p95")] = +p95;
      if (p99 != null) s.lat[LK(op,"p99")] = +p99;
    }
    // Reduce per-node remaining MB (nodes at 0 included) to min/mean/max/delta.
    if (nodeCols.length){
      var vals = [];
      for (var nc=0;nc<nodeCols.length;nc++){ var v: any = _at(nodeCols[nc],i); if (v != null) vals.push(+v); }
      if (vals.length){
        var mn=vals[0], mx=vals[0], sum=0;
        for (var j=0;j<vals.length;j++){ var vv=vals[j]; if(vv<mn)mn=vv; if(vv>mx)mx=vv; sum+=vv; }
        s.rmin=mn; s.rmean=sum/vals.length; s.rmax=mx; s.rdelta=(mx-mn);
        if (baseSum == null || sum > baseSum){ baseSum = sum; baseSample = s; }
      }
    }
    samples.push(s);
  }
  // rratio can only be scaled once the whole run has been seen, so it's a second pass: each
  // tick's spread relative to the baseline mean, flagging the baseline sample itself for the
  // consumers that report the skew there.
  if (baseSample){
    baseSample.rbase = true;
    var baseMean = baseSample.rmean;
    samples.forEach(function(s: any){
      if (s.rdelta != null) s.rratio = (baseMean > 0 ? s.rdelta/baseMean : 0);
    });
  }

  // Download %/MB-s as their own {el,pct,mbps} series (non-null ticks), then filled onto
  // every sample by held interpolation.
  var dlpts = [];
  for (var di=0;di<el.length;di++){ var p = _at(pctCol,di);
    if (p != null) dlpts.push({el:+el[di], pct:+p, mbps:_n(_at(mbpsCol,di))}); }
  dlpts.sort(function(a,b){ return a.el-b.el; });
  if (dlpts.length){
    samples.forEach(function(s){ var d = _dl_at(dlpts, s.el); s.pct = d.pct/100; s.mbps = d.mbps; });
  }

  // Derive the "agg" op (Overall Workload Latency): per-sample QPS-weighted mean latencies.
  samples.forEach(function(s){
    var a = qps_weighted_agg(s.lat, s.qps);
    if (a){ s.lat[LK("agg","p50")]=a.p50; s.lat[LK("agg","p95")]=a.p95;
            s.lat[LK("agg","p99")]=a.p99; s.qps["agg"]=a.qps; }
  });
  return samples;
}

// Interpolate the download %/MB-s series at elapsed `el`, holding the endpoints (before the
// first / after the last reading, the latter being the steady-state tail at 100%).
function _dl_at(dl, el){
  var n = dl.length;
  if (el <= dl[0].el) return dl[0];
  if (el >= dl[n-1].el) return dl[n-1];
  for (var i=1;i<n;i++){ if (dl[i].el >= el){ var a=dl[i-1], b=dl[i], t=(b.el===a.el)?0:(el-a.el)/(b.el-a.el);
    return {pct:a.pct+(b.pct-a.pct)*t, mbps:_ln(a.mbps,b.mbps,t)}; } }
  return dl[n-1];
}

// --------------------------------------------------------------------------
// Run-level scalars (everything that isn't a time series)
// --------------------------------------------------------------------------

// The restore milestones `timings` reports, in the order they occur. `restored` is the
// completion marker; the three before it are usability thresholds — see RunTimings.
var MILESTONES = ["available", "functional", "healthy", "restored"];
// The three that get their own progress rows. `restored` is deliberately not one: the 100%
// download crossing is already that row. It rides along as the denominator of the overall
// throughput instead.
var USABILITY_MILESTONES = ["available", "functional", "healthy"];

// The optional run-level facts that ride alongside the sample series: the `timings`
// milestones, metadata.total_bytes (as MB, matching every other MB in the report), and the
// node count — which is simply how many per-node download columns the run carries. The test
// NAME is opaque; nothing is ever parsed out of it. Every field is optional: absent -> null,
// and the rows that need it are dropped rather than guessed at.
//
// The size is the reported total_bytes and nothing else. Deriving it from the download's own
// per-node remaining-MB columns was tried and is wrong: that counts external bytes still to
// fetch partway through, by which point linking may already have ingested files and compaction
// may have rewritten them. total_bytes is what the restore actually landed (see
// summary_report_spec.md §1.1) — the only figure a throughput number can honestly divide.
function run_info(run){
  var md = (run && run.metadata) || {};
  // Spec puts `timings` at the body level; also accept it under metadata, since it is a
  // per-run scalar block and that is the other place a generator would plausibly put it.
  var raw = (run && run.timings) || md.timings || {};
  var timings = {};
  MILESTONES.forEach(function(k){
    var v = _n(raw[k]);
    if (v != null && isFinite(v) && v >= 0) timings[k] = v;
  });
  var tb = _n(md.total_bytes);
  if (tb == null) tb = _n(run && run.total_bytes);
  var cols = run && run.download && run.download.node_remote_mb;
  return {
    timings: timings,
    // MB here is 2^20 bytes — the same unit as download.mbps and node_remote_mb, so the
    // throughput table's rows are all in one unit.
    total_mb: (tb != null && isFinite(tb) && tb > 0) ? tb/1048576 : null,
    nodes: (Array.isArray(cols) && cols.length) ? cols.length : null,
  };
}

export { qps_weighted_agg, parse_run, _dl_at, run_info, MILESTONES, USABILITY_MILESTONES };
