// Cells: A/B statistics at the download crossings.
import { crossing_sample } from "./series";
import { STALL_PCT, LK, OPS, LAT_METRICS, STALLS, CK, PRIMARY_OPS, PRIMARY_STALLS, PRIMARY_METRICS, MEASURE_WINDOW_S, MIN_RELIABLE_SAMPLES } from "../model/constants";
import { _summ, mann_whitney, hodges_lehmann, _ranges_overlap, median } from "./stats";
import { pyRound } from "../util";

function _cross_lat(run, op, metric, stall){
  var s = crossing_sample(run, STALL_PCT[stall]);
  if (!s) return null;
  var v = s.lat[LK(op,metric)];
  return (v === undefined) ? null : v;
}
function _cross_qps(run, op, stall){
  var s = crossing_sample(run, STALL_PCT[stall]);
  if (!s) return null;
  var v = s.qps[op];
  return (v === undefined) ? null : v;
}

function build_cells(ctl_runs, exp_runs){
  var cells = {};      // key -> cell
  var order = [];      // ordered keys (OPS x LAT_METRICS x STALLS)
  OPS.forEach(function(op){
    LAT_METRICS.forEach(function(metric){
      STALLS.forEach(function(stall){
        var c = {op:op, metric:metric, stall:stall, ctl:[], exp:[], stats:{}};
        ctl_runs.forEach(function(run){ var v=_cross_lat(run,op,metric,stall); if (v!==null) c.ctl.push(v); });
        exp_runs.forEach(function(run){ var v=_cross_lat(run,op,metric,stall); if (v!==null) c.exp.push(v); });
        var k = CK(op,metric,stall);
        cells[k] = c; order.push(k);
      });
    });
  });
  return {cells:cells, order:order};
}
function qps_median(runs, op, stall){
  var vals = [];
  runs.forEach(function(run){ var v=_cross_qps(run,op,stall); if (v!==null) vals.push(v); });
  return vals.length ? median(vals) : null;
}
function compute_cell_stats(c, ctl_runs, exp_runs){
  var ctl_s = _summ(c.ctl), exp_s = _summ(c.exp);
  var mw = mann_whitney(c.ctl, c.exp);
  var hlv = hodges_lehmann(c.exp, c.ctl);

  var ratio = null, delta_pct = null;
  if (ctl_s.median !== null && ctl_s.median !== 0 && exp_s.median !== null){
    ratio = exp_s.median/ctl_s.median;
    delta_pct = (exp_s.median-ctl_s.median)/ctl_s.median*100.0;
  }
  var delta_mean = null, delta_mean_pct = null;
  if (ctl_s.mean !== null && ctl_s.mean !== 0 && exp_s.mean !== null){
    delta_mean = exp_s.mean-ctl_s.mean;
    delta_mean_pct = delta_mean/ctl_s.mean*100.0;
  }
  var ctl_qps = qps_median(ctl_runs, c.op, c.stall);
  var exp_qps = qps_median(exp_runs, c.op, c.stall);
  var n_samp = null;
  if (ctl_qps !== null && exp_qps !== null) n_samp = pyRound(Math.min(ctl_qps,exp_qps)*MEASURE_WINDOW_S, 0);
  var reliable = (n_samp !== null && n_samp >= MIN_RELIABLE_SAMPLES);

  c.stats = {
    ctl:ctl_s, exp:exp_s, U:mw[0], p:mw[1], method:mw[2],
    hl:hlv[0], hl_lo:hlv[1], hl_hi:hlv[2], ratio:ratio, delta_pct:delta_pct,
    delta_mean:delta_mean, delta_mean_pct:delta_mean_pct,
    ctl_qps:ctl_qps, exp_qps:exp_qps, n_samp:n_samp, reliable:reliable,
    overlap:_ranges_overlap(c.ctl, c.exp), _q:null,
  };
  return c.stats;
}
function is_primary(op, metric, stall){
  return PRIMARY_OPS.indexOf(op)>=0 && PRIMARY_STALLS.indexOf(stall)>=0 && PRIMARY_METRICS.indexOf(metric)>=0;
}

export { _cross_lat, _cross_qps, build_cells, qps_median, compute_cell_stats, is_primary };
