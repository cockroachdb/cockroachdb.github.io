// Series helpers: crossings, resampling onto a grid, per-op plot series.
import { LK, LAT_METRICS } from "../model/constants";
import { _interp } from "./interp";
import { _mean_std } from "./stats";
import { pyRound } from "../util";

// --------------------------------------------------------------------------
// Series helpers: crossings, interpolation, resampling
// --------------------------------------------------------------------------

function crossing_sample(samples, pct){
  for (var i=0;i<samples.length;i++){
    if (samples[i].pct*100.0 >= pct) return samples[i];
  }
  return null;
}
function _xy(samples, op, metric, xkey){
  var pts = [];
  for (var i=0;i<samples.length;i++){
    var s = samples[i];
    // qps (per op) and the run-global series (mbps, per-node remote-MB reductions) live
    // outside the lat map.
    var y = (metric === "qps") ? s.qps[op]
          : (metric === "mbps") ? s.mbps
          : (metric === "rmin") ? s.rmin
          : (metric === "rmean") ? s.rmean
          : (metric === "rmax") ? s.rmax
          : (metric === "rratio") ? s.rratio
          : (metric === "rdelta") ? s.rdelta
          : s.lat[LK(op,metric)];
    if (y === null || y === undefined) continue;
    var x = xkey === "el" ? s.el : s.pct*100.0;
    pts.push([x, y]);
  }
  pts.sort(function(a,b){return a[0]-b[0];});
  return pts;
}

// Resample each run onto `grid` and reduce across runs to mean+std+min/max per grid point.
// With `hold`, each run's value is held flat OUTSIDE its sampled range instead of being
// dropped (plain _interp -> null): a finished run must keep contributing its final value to
// the across-run mean (e.g. 0 remaining, 100% downloaded), else the averaged curve drifts
// back — a pure averaging artifact. Same rationale as download_curve. (Without hold, an
// empty run's _interp returns null and is skipped, so no guard is needed.)
function resample(runs, op, metric, xkey, grid, hold?){
  var xys = runs.map(function(r){ return _xy(r, op, metric, xkey); });
  var out = [];
  for (var gi=0;gi<grid.length;gi++){
    var g = grid[gi];
    var ys = [];
    for (var k=0;k<xys.length;k++){
      var xy = xys[k], v;
      if (hold){
        if (!xy.length) continue;
        v = g <= xy[0][0] ? xy[0][1]
          : g >= xy[xy.length-1][0] ? xy[xy.length-1][1]
          : _interp(xy, g);
      } else {
        v = _interp(xy, g);
      }
      if (v !== null) ys.push(v);
    }
    if (ys.length){
      var ms = _mean_std(ys);
      var lo = ys[0], hi = ys[0];
      for (var q=1;q<ys.length;q++){ if (ys[q]<lo) lo=ys[q]; if (ys[q]>hi) hi=ys[q]; }
      out.push({x:g, m:pyRound(ms[0],3), s:pyRound(ms[1],3),
                lo:pyRound(lo,3), hi:pyRound(hi,3), n:ys.length});
    }
  }
  return out;
}
function download_curve(runs, grid_el){
  var xys = runs.map(function(r){
    return r.map(function(s){return [s.el, s.pct*100.0];}).sort(function(a,b){return a[0]-b[0];});
  });
  var out = [];
  for (var gi=0;gi<grid_el.length;gi++){
    var g = grid_el[gi];
    var ys = [];
    for (var k=0;k<xys.length;k++){
      var xy = xys[k];
      if (!xy.length) continue;
      // Hold each run's value flat outside its sampled range instead of dropping
      // it: download progress only rises and stays at 100% once complete, so a
      // finished run must keep contributing 100% at later grid points. Dropping it
      // (plain _interp -> null) removes a 100% value and makes the AVERAGED curve
      // dip back down — a pure averaging artifact, not real de-download.
      var v = g <= xy[0][0] ? xy[0][1]
            : g >= xy[xy.length-1][0] ? xy[xy.length-1][1]
            : _interp(xy, g);
      if (v !== null) ys.push(v);
    }
    if (ys.length){
      var m = 0, lo = ys[0], hi = ys[0];
      for (var i=0;i<ys.length;i++){ m += ys[i]; if (ys[i]<lo) lo=ys[i]; if (ys[i]>hi) hi=ys[i]; }
      m /= ys.length;
      out.push({x:g, y:pyRound(m, 2), lo:pyRound(lo, 2), hi:pyRound(hi, 2)});
    }
  }
  return out;
}
function crossings_elapsed(runs){
  var out = {};
  [30,60,90,100].forEach(function(pct){
    var els = [];
    for (var i=0;i<runs.length;i++){ var s = crossing_sample(runs[i], pct); if (s !== null) els.push(s.el); }
    if (els.length){ var sum=0; els.forEach(function(v){sum+=v;}); out[pct] = pyRound(sum/els.length, 1); }
  });
  return out;
}

function build_series(op, ctl_runs, exp_runs, dual, el_grid, pct_grid){
  var arms = [["ctl", ctl_runs]];
  if (dual) arms.push(["exp", exp_runs]);
  var el = {}, pc = {}, dl = {}, cr = {}, elRuns = {}, pcRuns = {}, dlRuns = {}, ep = {}, epRuns = {};
  // qps (per op) as its own mean + per-run series, elapsed and pct x — an optional
  // dashed overlay on the latency plots (its own scale, not ms).
  var qpEl = {}, qpPc = {}, qpElRuns = {}, qpPcRuns = {};
  // mbps (global download rate) mean+std+per-run series — the download chart's 2nd axis.
  var mb = {}, mbPc = {}, mbRuns = {}, mbPcRuns = {};
  // Per-node remote-MB skew (run-global): absolute min/mean/max across nodes (y1) plus the
  // long-pole ratio (max-mean)/mean and max−min delta (y2). One map per (variant × level),
  // keyed r<Level>[Pc][Runs] and collected in R. Built variant-major (el, then Pc, then
  // Runs, then PcRuns) so the returned key order matches the rest of the series object.
  var RLEVELS = ["min","mean","max","ratio","delta"];
  var RVARIANTS = ["", "Pc", "Runs", "PcRuns"];
  var rcap = function(lv){ return "r"+lv.charAt(0).toUpperCase()+lv.slice(1); };
  var R: any = {};
  RVARIANTS.forEach(function(v){ RLEVELS.forEach(function(lv){ R[rcap(lv)+v] = {}; }); });
  var toPts = function(xy){ return xy.map(function(p){return {x:p[0], y:p[1]};}); };
  arms.forEach(function(pair){
    var arm = pair[0], runs = pair[1];
    if (!runs.length) return;
    // The %-downloaded axis is only defined up to 100%. Post-download steady-state
    // samples all carry pct==100, so for the pct-based series we truncate each run
    // at its first 100% reading. Elapsed mode keeps the full run (the tail extends
    // naturally to the right in time).
    // TODO: figure out how %-mode should actually render post-download readings
    // (e.g. synthesize x>100 scaled by time-since-complete). Ill-defined for now,
    // so we simply end the %-mode curves at the first 100% sample.
    var pruns = runs.map(function(r){
      for (var i=0;i<r.length;i++){ if (r[i].pct*100.0 >= 100) return r.slice(0,i+1); }
      return r;
    });
    // At each % grid point: mean elapsed (also used to clip the %-series .e range).
    // ELAPSED-by-% is the %-mode second-y curve (ep, mean+min/max) + ensemble
    // (epRuns): every run starts at (0%, 0s) and rises, reaching 100% at whatever
    // time it finishes. The band is thus pinned at 0 on the left and fans out to the
    // right — the runs started together and diverged as they ran. (A "time
    // remaining" curve inverts this, placing a slower run higher at 0% as if it had
    // started behind, which it hadn't.)
    var pct_el = {}, epArr = [];
    pct_grid.forEach(function(g){
      var els = [];
      for (var k=0;k<pruns.length;k++){
        var xy = pruns[k].map(function(s){return [s.pct*100.0, s.el];}).sort(function(a,b){return a[0]-b[0];});
        var v = _interp(xy, g);
        if (v !== null) els.push(v);
      }
      pct_el[g] = els.length ? (els.reduce(function(a,b){return a+b;},0)/els.length) : null;
      if (els.length){
        var m=0, lo=els[0], hi=els[0];
        for (var q=0;q<els.length;q++){ m+=els[q]; if(els[q]<lo)lo=els[q]; if(els[q]>hi)hi=els[q]; }
        m/=els.length;
        epArr.push({x:g, y:pyRound(m,1), lo:pyRound(lo,1), hi:pyRound(hi,1)});
      }
    });
    ep[arm] = epArr;
    epRuns[arm] = pruns.map(function(r){
      return r.map(function(s){return {x:s.pct*100.0, y:s.el};}).sort(function(a,b){return a.x-b.x;});
    });
    LAT_METRICS.forEach(function(metric){
      el[arm+"_"+metric] = resample(runs, op, metric, "el", el_grid);          // elapsed: full run
      var pts = resample(pruns, op, metric, "pct", pct_grid);                  // pct: truncated at 100%
      pts.forEach(function(p){ var e = pct_el[p.x]; p.e = (e !== null && e !== undefined) ? pyRound(e,1) : null; });
      pc[arm+"_"+metric] = pts;
      // Raw per-run polylines (ensemble mode) — actual sample points, no resampling.
      elRuns[arm+"_"+metric] = runs.map(function(r){ return toPts(_xy(r, op, metric, "el")); });
      pcRuns[arm+"_"+metric] = pruns.map(function(r){ return toPts(_xy(r, op, metric, "pct")); });
    });
    dl[arm] = download_curve(runs, el_grid);
    dlRuns[arm] = runs.map(function(r){
      return r.map(function(s){return {x:s.el, y:s.pct*100.0};}).sort(function(a,b){return a.x-b.x;});
    });
    qpEl[arm] = resample(runs, op, "qps", "el", el_grid);
    qpPc[arm] = resample(pruns, op, "qps", "pct", pct_grid);
    qpElRuns[arm] = runs.map(function(r){ return toPts(_xy(r, op, "qps", "el")); });
    qpPcRuns[arm] = pruns.map(function(r){ return toPts(_xy(r, op, "qps", "pct")); });
    // mbps is download-global (op ignored by _xy); mean+std+min/max like latency. Drop
    // the x=0 origin (rate 0, no predecessor) AND the first non-zero point: that first
    // interval's rate spans [0, t1] and is skewed by bytes downloaded before t0 during
    // link setup. The reported rate is only trustworthy from the SECOND non-zero sample
    // onward, so plot from there.
    var pos=function(pts){ return pts.filter(function(p){return (p.x!=null?p.x:p[0])>0;}).slice(1); };
    mb[arm] = pos(resample(runs, op, "mbps", "el", el_grid));
    mbPc[arm] = pos(resample(pruns, op, "mbps", "pct", pct_grid));
    mbRuns[arm] = runs.map(function(r){ return pos(toPts(_xy(r, op, "mbps", "el"))); });
    mbPcRuns[arm] = pruns.map(function(r){ return pos(toPts(_xy(r, op, "mbps", "pct"))); });
    // Remote-MB reductions (op ignored by _xy — run-global). Elapsed uses resample(...,hold)
    // so finished runs stay at 0; ratio too (mean=0 -> ratio 0 after completion). pct series
    // truncate at 100%. Same shapes as latency: mean (el/pct) + per-run ensemble (Runs/PcRuns).
    RLEVELS.forEach(function(lv){ var metric="r"+lv, base=rcap(lv);
      R[base][arm]          = resample(runs,  op, metric, "el",  el_grid, true);
      R[base+"Pc"][arm]     = resample(pruns, op, metric, "pct", pct_grid);
      R[base+"Runs"][arm]   = runs.map(function(r){ return toPts(_xy(r, op, metric, "el")); });
      R[base+"PcRuns"][arm] = pruns.map(function(r){ return toPts(_xy(r, op, metric, "pct")); });
    });
    var ce = crossings_elapsed(runs);
    var crArm = {}; for (var kk in ce) crArm[String(kk)] = ce[kk];
    cr[arm] = crArm;
  });
  // R holds the remote maps in variant-major order (rMin,rMean,…,rMinPc,…), appended after
  // the fixed keys so the whole object's key order matches the original.
  return Object.assign({big: op === "agg", el: el, pc: pc, dl: dl, cr: cr,
          elRuns: elRuns, pcRuns: pcRuns, dlRuns: dlRuns, ep: ep, epRuns: epRuns,
          qpEl: qpEl, qpPc: qpPc, qpElRuns: qpElRuns, qpPcRuns: qpPcRuns,
          mb: mb, mbPc: mbPc, mbRuns: mbRuns, mbPcRuns: mbPcRuns}, R);
}

export { crossing_sample, _xy, resample, download_curve, crossings_elapsed, build_series };
