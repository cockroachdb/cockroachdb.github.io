// Analysis driver: parse arms -> cells + stats + series + provenance -> ctx.
import { OPS, POINT_OPS, SCAN_OPS, MIXED_OPS, LAT_METRICS, STALLS, STALL_PCT, PRIMARY_OPS, PRIMARY_STALLS, PRIMARY_METRICS, NEG_CONTROL_MARGIN_PCT, EQUIV_MARGIN_PCT, MIN_RELIABLE_SAMPLES, ALPHA, FDR_Q, PCT_GRID_STEP, CK, HARNESS_SETTINGS } from "../model/constants";
import { mann_whitney, bh_fdr, _summ } from "./stats";
import { build_cells, compute_cell_stats, qps_median, is_primary } from "./cells";
import { build_series, crossing_sample } from "./series";
import { parse_run } from "./ingest";
import { _g2, _tlabel } from "../format/format";
import { clean, NAN, isnan } from "../util";

// Time-anchored table rows (fixed elapsed points within the mean restore duration).
function time_rows(refComplete){
  // Fixed elapsed points strictly within the (mean) restore duration...
  var base = [0,60,180,300,600,1200,1800,2700,3600];   // 0,1,3,5,10,20,30,45,60m
  var rows = [];
  base.forEach(function(t){ if (t < refComplete) rows.push({t:t, label:_tlabel(t)}); });
  for (var t=5400; t < refComplete; t += 1800) rows.push({t:t, label:_tlabel(t)});   // then every 30m
  // ...then restore-complete and +1m, anchored PER RUN at its own 100% time (not a
  // shared clock), so "done" is genuinely at completion (download 100%).
  rows.push({special:"done",   label:"done"});
  rows.push({special:"done1m", label:"done+1m"});
  return rows;
}

// --------------------------------------------------------------------------
// Analysis driver (port of analyze(); takes arms instead of dirs)
// arms: [{label,name,sha,dirty,settings,buildTime,test,commit,branch,
//         runs:[rawSamplesArray, ...]}]  (arm B optional)
// --------------------------------------------------------------------------

function analyze(arms){
  var dual = arms.length > 1;

  function loadArm(arm){
    var runs = [];
    (arm.runs || []).forEach(function(raw){
      var s = parse_run(raw);
      if (s.length) runs.push(s);
    });
    return runs;
  }
  // A run with no usable samples is almost always a pre-v:2 body (old {download:[...],
  // samples:{...}} instead of {elapsed, download:{...}, ops:{...}}) — point at the spec.
  function noSamples(which, arm){
    var r0 = (arm && arm.runs || [])[0];
    var stale = r0 && !r0.elapsed && (Array.isArray(r0.download) || r0.samples);
    return "arm "+which+" has no runs with usable samples"
      + (stale ? " — run body looks pre-v:2 (missing `elapsed`/`ops`); expected the v:2 body from summary_report_spec.md" : "");
  }
  var ctl_runs = loadArm(arms[0]);
  if (!ctl_runs.length) throw new Error(noSamples("A", arms[0]));
  var exp_runs = [];
  if (dual){
    exp_runs = loadArm(arms[1]);
    if (!exp_runs.length) throw new Error(noSamples("B", arms[1]));
  }

  var prov_ctl = arms[0], prov_exp = dual ? arms[1] : {settings:{}};
  var cl = arms[0].label || "A";
  var el = dual ? (arms[1].label || "B") : null;

  var bc = build_cells(ctl_runs, exp_runs);
  var cells = bc.cells, order = bc.order;
  order.forEach(function(k){ compute_cell_stats(cells[k], ctl_runs, exp_runs); });

  // Exploratory FDR: all latency cells NOT in the primary family.
  var primary_keys = [];
  PRIMARY_OPS.forEach(function(op){ PRIMARY_STALLS.forEach(function(s){ PRIMARY_METRICS.forEach(function(m){
    primary_keys.push(CK(op,m,s));
  }); }); });
  var primarySet = {}; primary_keys.forEach(function(k){ primarySet[k]=1; });
  var expl_p = [], valid_expl = [];
  order.forEach(function(k){
    if (primarySet[k]) return;
    var p = cells[k].stats.p;
    if (!isnan(p)){ expl_p.push(p); valid_expl.push(k); }
  });
  var qvals = bh_fdr(expl_p);
  for (var vi=0;vi<valid_expl.length;vi++) cells[valid_expl[vi]].stats._q = qvals[vi];

  // ---- Comparison-only summaries (dual mode) ----
  var neg_control = null, qps_status = null, confounds = [], conclusion = null;
  if (dual){
    var ng_rows = [], ng_hard_fail = false, ng_noisy = false;
    ["agg","stockLevel"].forEach(function(op){
      LAT_METRICS.forEach(function(metric){
        var st = cells[CK(op,metric,"download_0")].stats;
        var dp = st.delta_pct;
        var within = (dp !== null && Math.abs(dp) <= NEG_CONTROL_MARGIN_PCT);
        var overlap = st.overlap;
        var status;
        if (within) status = "PASS";
        else if (overlap){ status = "NOISY"; ng_noisy = true; }
        else { status = "FAIL"; ng_hard_fail = true; }
        ng_rows.push({op:op, metric:metric, ctl:st.ctl.median, exp:st.exp.median, dpct:dp,
          within:within, overlap:overlap, status:status});
      });
    });
    neg_control = {pass:!ng_hard_fail, noisy:ng_noisy, rows:ng_rows};

    var agg_dpcts = [];
    STALLS.forEach(function(stall){
      var cq = qps_median(ctl_runs,"agg",stall), eq = qps_median(exp_runs,"agg",stall);
      if (cq && eq) agg_dpcts.push(Math.abs((eq-cq)/cq*100.0));
    });
    var perop_dpcts = [];
    OPS.forEach(function(op){ if (op==="agg") return;
      STALLS.forEach(function(stall){
        var cq = qps_median(ctl_runs,op,stall), eq = qps_median(exp_runs,op,stall);
        if (cq && eq) perop_dpcts.push(Math.abs((eq-cq)/cq*100.0));
      });
    });
    var max_agg = agg_dpcts.length ? Math.max.apply(null,agg_dpcts) : null;
    qps_status = {max_abs_dpct:max_agg,
      max_perop_abs_dpct:(perop_dpcts.length?Math.max.apply(null,perop_dpcts):null),
      equivalent:(max_agg !== null && max_agg <= EQUIV_MARGIN_PCT)};

    function _qstr(st){
      var q = st._q;
      if (q === null || q === undefined || isnan(q)) return "n/a";
      return _g2(q) + (q < FDR_Q ? " (survives FDR)" : " (NOT FDR-sig)");
    }
    POINT_OPS.forEach(function(op){ LAT_METRICS.forEach(function(metric){ STALLS.forEach(function(stall){
      var st = cells[CK(op,metric,stall)].stats;
      if (!isnan(st.p) && st.p < ALPHA && st.delta_pct !== null && Math.abs(st.delta_pct) > EQUIV_MARGIN_PCT){
        confounds.push("point-op "+op+" "+metric+"@"+STALL_PCT[stall]+"% moved (Δ%="
          +(st.delta_pct>=0?"+":"")+st.delta_pct.toFixed(1)+", exact p="+_g2(st.p)+", FDR q="+_qstr(st)
          +") — download ordering should not move point ops.");
      }
    }); }); });
    ["download_0","download_100"].forEach(function(stall){
      SCAN_OPS.concat(MIXED_OPS).concat(["agg"]).forEach(function(op){
        PRIMARY_METRICS.forEach(function(metric){
          var st = cells[CK(op,metric,stall)].stats;
          if (!isnan(st.p) && st.p < ALPHA && st.delta_pct !== null && Math.abs(st.delta_pct) > EQUIV_MARGIN_PCT){
            var tag = stall === "download_0" ? "negative control" : "steady state";
            confounds.push(tag+" "+op+" "+metric+"@"+STALL_PCT[stall]+"% moved (Δ%="
              +(st.delta_pct>=0?"+":"")+st.delta_pct.toFixed(1)+", exact p="+_g2(st.p)+", FDR q="+_qstr(st)+").");
          }
        });
      });
    });

    var prim_sig = [];
    primary_keys.forEach(function(k){
      var st = cells[k].stats;
      if (!isnan(st.p) && st.p < ALPHA && st.ratio !== null) prim_sig.push([k, st]);
    });
    if (prim_sig.length){
      var improved = prim_sig.filter(function(ks){ return ks[1].ratio < 1; });
      var best = prim_sig.reduce(function(a,b){ return b[1].ratio < a[1].ratio ? b : a; });
      var pk = best[0], bst = best[1];
      var parts = pk.split("|");   // op|metric|stall
      conclusion = "Primary family: "+prim_sig.length+"/"+primary_keys.length+" cells significant (exact p<"
        +ALPHA+"); "+improved.length+" improvements. Largest: "+parts[0]+" "+parts[1]+"@"+STALL_PCT[parts[2]]
        +"% Δ%="+bst.delta_pct.toFixed(0)+" (ratio "+bst.ratio.toFixed(2)+"x).";
    } else {
      conclusion = "Primary family: no cells reach exact p<"+ALPHA+".";
    }
  }

  // ---- Details table (from arm provenance fields; "—" when absent) ----
  // _fmtTs reformats the roachtest invocation stamp baked into the run-dir path
  // ("yymmdd-HHMMSS", e.g. "260722-164502") into the same "YYYY/MM/DD HH:MM:SS" shape the
  // other timestamps use. Returns null on anything that isn't that stamp.
  function _fmtTs(ts){
    var m = /^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(ts || "");
    return m ? ("20"+m[1]+"/"+m[2]+"/"+m[3]+" "+m[4]+":"+m[5]+":"+m[6]) : null;
  }
  function _arm_detail(arm, label, hue){
    // Show each arm's own (non-harness) settings, like sha/version — NOT a diff against the
    // other arm. A setting shared by both arms still appears under both, so it isn't hidden
    // just because the two happen to match.
    var mine = arm.settings || {};
    var filtered = {};
    for (var k in mine){ if (!HARNESS_SETTINGS[k]) filtered[k] = mine[k]; }
    // "ran" is the `roachtest run` invocation stamp (arm.ts, baked into the path and shared
    // by every run of the arm, and by sibling A/B arms of the same invocation). It is NOT a
    // per-run test.log start time: an arm bundles many runs with different start times, so
    // no single run's time represents the arm. Null (shown "—") when there's no stamp (e.g.
    // the --teamcity bare run_N layout).
    var ran = _fmtTs(arm.ts) || null;
    return {label:label, name:(arm.name||"—"), n:(arm.runs?arm.runs.length:0), hue:hue,
      time:ran, build_time:(arm.buildTime||null),
      test:(arm.test||arm.name||null), version:(arm.version||null),
      commit:(arm.commit||null), branch:(arm.branch||null),
      settings:filtered};
  }
  var prov_details = [[cl, _arm_detail(prov_ctl, cl, "--ctl-p95")]];
  if (dual) prov_details.push([el, _arm_detail(prov_exp, el, "--lh-p95")]);

  // ---- Timing (elapsed-to-stall) from crossings ----
  var stall_pcts = [50,90,100];
  function _stall_elapsed(runs, pct){
    var out = [];
    runs.forEach(function(run){ var s = crossing_sample(run, pct); if (s !== null) out.push(s.el); });
    return out;
  }
  function _agg_timing(runs){
    var out = {};
    stall_pcts.forEach(function(pct){
      out[pct] = _summ(_stall_elapsed(runs, pct));
    });
    return out;
  }
  var timing = {ctl:_agg_timing(ctl_runs), exp:_agg_timing(exp_runs)};

  // Elapsed-to-download-% per arm. Dual: A|B|Δ|Δ%|p. Solo: just the control arm's elapsed
  // (single column) so the table still shows for one run set. Dual rows are unchanged.
  var time_to_stall = [];
  stall_pcts.forEach(function(pct){
    var ct = timing.ctl[pct], et = timing.exp[pct];
    if (!dual){ if (ct.mean !== null) time_to_stall.push({pct:pct, a:ct.mean, a_std:ct.std, b:null, b_std:null, dsec:null, dpct:null, p:NAN}); return; }
    var cv = _stall_elapsed(ctl_runs, pct), ev = _stall_elapsed(exp_runs, pct);
    var mw = (cv.length && ev.length) ? mann_whitney(cv, ev) : [NAN, NAN, "none"];
    var dsec = null, dpct = null;
    if (ct.mean !== null && et.mean !== null){
      dsec = et.mean - ct.mean;
      if (ct.mean) dpct = dsec/ct.mean*100.0;
    }
    time_to_stall.push({pct:pct, a:ct.mean, a_std:ct.std, b:et.mean, b_std:et.std,
      dsec:dsec, dpct:dpct, p:mw[1]});
  });

  // ---- Download throughput (MB/s): per-run avg & peak, with A/B stats ----
  // One value per run (avg or peak of its MB/s readings), so the A/B comparison is the
  // same run-level MWU used for elapsed-to-stall — n = number of runs, not samples.
  function _run_mbps(run){
    // Elapsed-ordered MB/s readings, dropping el<=0 and the first non-zero reading: that
    // interval spans [0, t1] and is skewed by bytes moved during link setup (the same
    // exclusion the MB/s plot makes), which otherwise dominates the peak.
    var pts = [];
    run.forEach(function(s){ if (s.mbps != null && s.el > 0) pts.push([s.el, s.mbps]); });
    pts.sort(function(a,b){ return a[0]-b[0]; });
    return pts.slice(1).map(function(p){ return p[1]; });
  }
  function _mbps_per_run(runs, reduce){
    var out = [];
    runs.forEach(function(r){ var v = _run_mbps(r); if (v.length) out.push(reduce(v)); });
    return out;
  }
  var _vmean = function(xs){ var s=0; for (var i=0;i<xs.length;i++) s+=xs[i]; return xs.length?s/xs.length:null; };
  var _vmax = function(xs){ return xs.length ? Math.max.apply(null, xs) : null; };
  // Dual: A|B|Δ|Δ%|p. Solo: just the control arm's avg/peak MB/s (single column). Dual unchanged.
  var mbps_rows = [];
  [["avg MB/s", _vmean], ["peak MB/s", _vmax]].forEach(function(pr){
    var cv = _mbps_per_run(ctl_runs, pr[1]);
    var cs = _summ(cv);
    if (!dual){ if (cs.mean !== null) mbps_rows.push({label:pr[0], a:cs.mean, a_std:cs.std, b:null, b_std:null, d:null, dpct:null, p:NAN}); return; }
    var ev = _mbps_per_run(exp_runs, pr[1]);
    var es = _summ(ev);
    var mw = (cv.length && ev.length) ? mann_whitney(cv, ev) : [NAN, NAN, "none"];
    var d = (cs.mean !== null && es.mean !== null) ? es.mean - cs.mean : null;
    var dpct = (d !== null && cs.mean) ? d/cs.mean*100.0 : null;
    mbps_rows.push({label:pr[0], a:cs.mean, a_std:cs.std, b:es.mean, b_std:es.std,
      d:d, dpct:dpct, p:mw[1]});
  });
  // Nodes (from the test name, e.g. ".../nodes=5/...") so the table reports per-node
  // MB/s, matching the download chart's MB/s axis. null -> unknown -> cluster total.
  var nodes = (function(){ for (var i=0;i<arms.length;i++){ var t = arms[i] && arms[i].test;
    var m = t && /nodes=(\d+)/.exec(t); if (m) return +m[1]; } return null; })();

  // ---- Plot series (dense) ----
  var all_runs = ctl_runs.concat(exp_runs);
  var max_el = 0.0, _elset = {};
  all_runs.forEach(function(run){ run.forEach(function(s){ if (s.el > max_el) max_el = s.el; _elset[s.el]=1; }); });
  // Grid = the actual sample elapsed times (union across runs), not a fixed step, so
  // every emitted sample shows as a point — a denser early cadence (e.g. an added 15s
  // sample) isn't lost to a coarse grid. resample() interpolates each run onto it.
  var el_grid = Object.keys(_elset).map(Number).sort(function(a,b){return a-b;});
  if (!el_grid.length) el_grid = [0];
  var pct_grid = [];   // 0..100 step PCT_GRID_STEP (Python range(0, 102, 2))
  for (var pg=0; pg <= 100; pg += PCT_GRID_STEP) pct_grid.push(pg);
  var series = {};
  OPS.forEach(function(op){ series[op] = build_series(op, ctl_runs, exp_runs, dual, el_grid, pct_grid); });
  var xmax_el = el_grid.length ? el_grid[el_grid.length-1]*1.0 : 1.0;

  // Time-anchored table rows: fixed elapsed points within the mean restore
  // duration (across all runs, both arms), + restore complete + 1m post. Fixed
  // regardless of arm/run selection; values interpolate the selection at each time.
  var completes = all_runs.map(function(r){ var s = crossing_sample(r, 100);
    if (s) return s.el; var mx=0; r.forEach(function(x){ if (x.el>mx) mx=x.el; }); return mx; });
  var refComplete = completes.length ? completes.reduce(function(a,b){return a+b;},0)/completes.length : max_el;
  var timeRows = time_rows(refComplete);

  // Chart payload + labels in the report's op order.
  var op_order = ["agg","stockLevel","orderStatus","delivery","newOrder","payment"];
  var chartData = {}; op_order.forEach(function(op){ chartData[op] = series[op]; });
  var labels = {ctl:cl, exp:(el||"B")};

  return {
    cells:cells, order:order, dual:dual, control_label:cl, experiment_label:el,
    prov_ctl:prov_ctl, prov_exp:prov_exp, prov_details:prov_details,
    n_ctl:ctl_runs.length, n_exp:exp_runs.length,
    neg_control:neg_control, qps_status:qps_status, confounds:confounds,
    primary_conclusion:conclusion, primary_keys:primary_keys,
    timing:timing, time_to_stall:time_to_stall, mbps_rows:mbps_rows, nodes:nodes,
    series:series, xmax_el:xmax_el,
    refComplete:refComplete, timeRows:timeRows,
    op_order:op_order, chartData:chartData, labels:labels,
  };
}

// --------------------------------------------------------------------------
// data.json shape (port of write_json), for equivalence testing.
// --------------------------------------------------------------------------
function data_json(ctx){
  var out = {
    control_label:ctx.control_label, experiment_label:ctx.experiment_label,
    n_control:ctx.n_ctl, n_experiment:ctx.n_exp,
    control_sha:(ctx.prov_ctl.sha||null), experiment_sha:(ctx.prov_exp?ctx.prov_exp.sha||null:null),
    negative_control:ctx.neg_control, qps_status:ctx.qps_status, confounds:ctx.confounds,
    thresholds:{neg_control_margin_pct:NEG_CONTROL_MARGIN_PCT, equiv_margin_pct:EQUIV_MARGIN_PCT,
      min_reliable_samples:MIN_RELIABLE_SAMPLES, alpha:ALPHA, fdr_q:FDR_Q},
    timing:{}, time_to_stall:[], cells:[], series:ctx.series,
  };
  ["ctl","exp"].forEach(function(arm){
    var t = ctx.timing[arm], o = {};
    Object.keys(t).forEach(function(pct){ o[String(pct)] = {n:t[pct].n, mean_s:t[pct].mean, std_s:t[pct].std}; });
    out.timing[arm] = o;
  });
  ctx.time_to_stall.forEach(function(r){
    out.time_to_stall.push({stall_pct:r.pct, a_elapsed_s:r.a, a_std_s:r.a_std, b_elapsed_s:r.b,
      b_std_s:r.b_std, delta_s:r.dsec, delta_pct:r.dpct, exact_p:clean(r.p)});
  });
  ctx.order.forEach(function(k){
    var c = ctx.cells[k], st = c.stats;
    function armObj(s){ return {n:s.n, mean:s.mean, std:s.std, median:s.median, q1:s.q1, q3:s.q3,
      min:s.min, max:s.max, values:s.vals}; }
    out.cells.push({op:c.op, metric:c.metric, stall:c.stall, stall_pct:STALL_PCT[c.stall],
      primary:is_primary(c.op,c.metric,c.stall),
      control:armObj(st.ctl), experiment:armObj(st.exp),
      U:clean(st.U), exact_p:clean(st.p), mwu_method:st.method,
      hl:clean(st.hl), hl_ci:[clean(st.hl_lo), clean(st.hl_hi)],
      ratio:st.ratio, delta_pct_median:st.delta_pct, delta_mean:st.delta_mean,
      delta_mean_pct:st.delta_mean_pct, fdr_q:st._q, approx_samples:st.n_samp, reliable:st.reliable});
  });
  return out;
}

export { analyze, data_json, time_rows };
