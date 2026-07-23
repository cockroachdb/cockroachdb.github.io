// HTML table generators (cells, op tables, time tables, provenance, throughput).
import { esc, _num, _pct, _sms, _pfmt, _g2, _e0 } from "../format/format";
import { isnan, NAN, pyRound } from "../util";
import { ALPHA, MAIN_METRICS } from "../model/constants";
import { mann_whitney, _summ } from "../compute/stats";
import { _iXY, _dlCrossT } from "../compute/interp";

function _avg(s, unit){
  unit = unit || "ms";
  if (s.mean === null || s.mean === undefined) return "–";
  // The ±std only means something with more than one run; omit it otherwise.
  var sd = (s.n > 1) ? '<span class="sd">±'+_num(s.std||0)+'</span>' : "";
  return '<span class="pval">'+_num(s.mean)+'</span><span class="unit">'+unit+'</span>'+sd;
}
// opts (optional): {unit:"ms"|"%", higherBetter:bool}. Default is latency-style —
// unit "ms" and lower-is-better (a negative delta is the "good" green). The
// download column passes {unit:"%", higherBetter:true} so more-downloaded is green.
function _group_cells(st, dual, op, metric, stage_pct, singleArm?, opts?){
  opts = opts || {}; var unit = opts.unit || "ms"; var goodPos = !!opts.higherBetter;
  var ids = 'data-op="'+op+'" data-metric="'+metric+'" data-stage="'+stage_pct+'"';
  if (!dual){ var arm = singleArm || 'ctl';
    return '<td class="vcell" data-arm="'+(arm==='ctl'?'A':'B')+'" '+ids+'>'+_avg(st[arm],unit)+'</td>'; }
  var p = st.p;
  var sig = (!isnan(p) && p < ALPHA);
  var dm = st.delta_mean, dmp = st.delta_mean_pct;
  // Only the delta cell dims when the difference isn't significant — the per-arm values (ctl/exp)
  // are still valid measurements, so they stay at full opacity; it's just their difference that's
  // noise. See the matching per-cell dimming in the download tables below.
  var dimc = sig ? "" : " dim";
  var a = '<td class="grpl vcell" data-arm="A" '+ids+'>'+_avg(st.ctl,unit)+'</td>';
  var b = '<td class="vcell" data-arm="B" '+ids+'>'+_avg(st.exp,unit)+'</td>';
  var dm_ids = 'data-metric="'+metric+'"';
  var d;
  if (dmp === null || dmp === undefined || isnan(p)){
    d = '<td class="dcell'+dimc+'" '+dm_ids+'>–</td>';
  } else {
    var improved = goodPos ? (dm > 0) : (dm < 0);
    var vr = improved ? "--good" : "--bad";
    var pcls = sig ? "psig" : "pns";
    d = '<td class="dcell'+dimc+'" '+dm_ids+'>'
      + '<span class="dval" style="color:var('+vr+')">'+_pct(dmp)+'</span>'
      + '<span class="pv '+pcls+'">p='+_pfmt(p)+'</span></td>';
  }
  return a+b+d;
}
// Elapsed at which to read run `i` of `arm` for this row: a fixed time, or that
// run's own download-complete (+60s for done+1m). null if the run never completed.
function _rowTimeRun(sop, arm, i, row){
  if (!row.special) return row.t;
  var comp = _dlCrossT((sop.dlRuns[arm]||[])[i], 100);
  return comp==null ? null : (row.special==="done1m" ? comp+60 : comp);
}
// Summary/MWU stats over the per-run interpolated latencies at the row's time, shaped for
// _group_cells (an A|B|Δ(p) group).
function _stats(ctl, exp){
  var cs = _summ(ctl), es = _summ(exp);
  var mw = (ctl.length && exp.length) ? mann_whitney(ctl, exp) : [NAN, NAN, "none"];
  var dm = (cs.mean!=null && es.mean!=null) ? es.mean-cs.mean : null;
  var dmp = (dm!=null && cs.mean) ? dm/cs.mean*100.0 : null;
  return {ctl:cs, exp:es, p:mw[1], delta_mean:dm, delta_mean_pct:dmp};
}
function _time_cell(sop, metric, row){
  function vals(arm){ var rr = sop.elRuns[arm+"_"+metric]||[];
    return rr.map(function(pl,i){ var t=_rowTimeRun(sop,arm,i,row); return t==null?null:_iXY(pl,t); })
             .filter(function(v){return v!=null;}); }
  return _stats(vals("ctl"), vals("exp"));
}
// Per-run download % reached by the row's time. On the special rows every run is 100% by
// construction (each is anchored at its own completion).
function _dl_cell(sop, row){
  function vals(arm){ var rr = sop.dlRuns[arm]||[];
    var out = row.special ? rr.map(function(){ return 100; }) : rr.map(function(pl){ return _iXY(pl, row.t); });
    return out.filter(function(v){return v!=null;}); }
  return _stats(vals("ctl"), vals("exp"));
}
function op_time_table(op, sop, dual, la, lb, timeRows, armMode?){
  var effDual = dual && (armMode===undefined || armMode==="both");
  var singleArm = (armMode==="A") ? "ctl" : (armMode==="B") ? "exp" : null;
  var dlOpts = {unit:"%", higherBetter:true};   // download: more is better -> green
  var cols = ["download"].concat(MAIN_METRICS);
  var out = ['<table class="tbl">'];
  if (effDual){
    out.push('<thead><tr><th class="l" rowspan="2">time</th>');
    cols.forEach(function(m){ out.push('<th colspan="3" class="grp" data-metric="'+m+'">'+m+'</th>'); });
    out.push('</tr><tr>');
    cols.forEach(function(m){
      out.push('<th class="grpl" data-metric="'+m+'">'+esc(la)+'</th><th data-metric="'+m+'">'+esc(lb)+'</th><th data-metric="'+m+'">Δ (p)</th>');
    });
    out.push('</tr></thead><tbody>');
  } else {
    var lab = singleArm==="exp" ? lb : la;
    out.push('<thead><tr><th class="l">time</th>');
    cols.forEach(function(m){ out.push('<th data-metric="'+m+'">'+m+(dual?' <span class="muted">('+esc(lab)+')</span>':'')+'</th>'); });
    out.push('</tr></thead><tbody>');
  }
  timeRows.forEach(function(row){
    var stageId = (row.t != null ? row.t : row.special);
    out.push('<tr><td class="l stage">'+esc(row.label)+'</td>');
    out.push(_group_cells(_dl_cell(sop, row), effDual, op, "download", stageId, singleArm, dlOpts));
    MAIN_METRICS.forEach(function(metric){
      out.push(_group_cells(_time_cell(sop, metric, row), effDual, op, metric, stageId, singleArm));
    });
    out.push('</tr>');
  });
  out.push('</tbody></table>');
  return out.join("");
}

function prov_table(ctx){
  var details = ctx.prov_details;   // [[label, detail], ...]
  var narms = details.length;
  var totalCols = 1 + narms;
  var armw = pyRound(76.0/narms, 2);
  var out = ['<table class="tbl prov"><colgroup><col style="width:24%">'];
  for (var i=0;i<narms;i++) out.push('<col style="width:'+armw+'%">');
  out.push('</colgroup><thead><tr><th class="l"></th>');
  details.forEach(function(pair, i){
    var label = pair[0], d = pair[1];
    // Header is the arm label (A/B) + color chip.
    out.push('<th class="l"><span class="chip" style="background:var('+d.hue+')"></span>'+esc(label)+'</th>');
  });
  out.push('</tr></thead><tbody>');
  function _plain(s){
    s = s.replace(/<br>/g,"; ").replace(/<[^>]+>/g,"");
    s = s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#x27;/g,"'");
    return s.trim();
  }
  function row(name, render, copytext?, merge?){
    merge = merge === undefined ? true : merge;
    var vals = details.map(function(pair){ return render(pair[1]); });
    var copies = details.map(function(pair){ return copytext ? copytext(pair[1]) : _plain(render(pair[1])); });
    if (merge && vals.length > 1 && vals.every(function(v){return v===vals[0];})){
      return '<tr><td class="l mid copyable" colspan="'+totalCols+'" data-copy="'+esc(copies[0])
        +'"><span class="rowlabel">'+name+'</span>'+vals[0]+'</td></tr>';
    }
    var body = "";
    for (var i=0;i<vals.length;i++) body += '<td class="l copyable" data-copy="'+esc(copies[i])+'">'+vals[i]+'</td>';
    return '<tr><td class="l">'+name+'</td>'+body+'</tr>';
  }
  // Commit subject + build id (+ branch) on ONE row, formatted as "title (version [branch])".
  // `version` is the generator's short build id (tag / sha / sha-dirty) — shown verbatim,
  // click-to-copy. Subject and version share a row so it merges across arms only when the
  // versions match (splitting them would let two builds of the same subject at different
  // versions collapse the subject while the version stayed split — misleading).
  function commit_cell(d){
    if (!d.version && !d.commit) return "—";
    // Truncate long text (subject, branch) to keep the row compact; full value on hover.
    var trunc = function(s, n){
      var full = String(s);
      if (full.length <= n) return esc(full);
      return '<span title="'+esc(full)+'">'+esc(full.slice(0, n - 1))+'…</span>';
    };
    var meta = [];
    if (d.version){
      var s = '<code class="copysha" data-copy="'+esc(d.version)+'" title="click to copy '+esc(d.version)+'">'+esc(d.version)+'</code>';
      if (d.branch) s += ' <code class="branch">'+trunc(d.branch, 12)+'</code>';
      meta.push(s);
    }
    var title = d.commit ? trunc(d.commit, 40) : "";
    var paren = meta.length ? '('+meta.join(' ')+')' : "";
    return (title && paren) ? (title+' '+paren) : (title || paren || "—");
  }
  function settings_cell(d){
    var s = d.settings;
    if (!s || !Object.keys(s).length) return "—";
    return Object.keys(s).sort().map(function(k){ return '<code>'+esc(k)+' = '+esc(s[k])+'</code>'; }).join("<br>");
  }
  out.push(row("runs", function(d){return esc(d.n);}, function(d){return String(d.n);}, false));
  out.push(row("ran", function(d){return esc(d.time || "—");}));
  out.push(row("test", function(d){return '<code>'+esc(d.test || "—")+'</code>';}));
  out.push(row("commit", commit_cell, function(d){return d.version || "";}));
  // Build time on its own row (below commit) so the "ran" row can merge across arms when
  // run times match even if the binaries were built at different times.
  out.push(row("built", function(d){return esc(d.build_time || "—");}));
  // Only show the settings row if some arm actually has non-default settings.
  if (details.some(function(pair){ var s = pair[1].settings; return s && Object.keys(s).length; }))
    out.push(row("non-default settings", settings_cell));
  out.push('</tbody></table>');
  return out.join("");
}
// ---- Shared A/B/Δ/Δ%/p table scaffolding (throughput / progress / distribution) ----
// These three download tables share a header + row shape; only the value formatting, the
// good-delta direction, and the row labels differ. `_dlHead` builds the opening; `_dlRow`
// renders one row given a descriptor (see the callers below).
function _dlHead(title, both, la, lb, armMode, valSuffix, deltaLabel){
  var out = '<table class="tbl dlt">'+_dlcols(both)+'<thead><tr><th class="l">'+title+'</th>';
  if (both) out += '<th>'+esc(la)+valSuffix+'</th><th>'+esc(lb)+valSuffix+'</th><th>'+deltaLabel+'</th><th>Δ%</th><th>p</th>';
  else out += '<th>'+esc(armMode === 'A' ? la : lb)+valSuffix+'</th>';
  return out + '</tr></thead><tbody>';
}
// o: {label, both, armMode, a, aStd, b, bStd, nCtl, nExp, d, dpct, p, goodPos,
//     fmtVal(v,sd,n)->cell, deltaVal(d)->str, deltaUnit}
function _dlRow(o){
  if (!o.both){
    var one = o.armMode === 'A' ? o.fmtVal(o.a, o.aStd, o.nCtl) : o.fmtVal(o.b, o.bStd, o.nExp);
    return '<tr><td class="l stage">'+o.label+'</td><td>'+one+'</td></tr>';
  }
  var p = o.p, sig = (!isnan(p) && p < ALPHA);
  var a = o.fmtVal(o.a, o.aStd, o.nCtl), b = o.fmtVal(o.b, o.bStd, o.nExp);
  var dcell, dpctc;
  if (o.d === null || o.d === undefined){ dcell = "–"; dpctc = "–"; }
  else {
    var improved = o.goodPos ? (o.d > 0) : (o.d < 0);
    var vr = improved ? "--good" : "--bad";
    dcell = '<span style="color:var('+vr+')">'+o.deltaVal(o.d)+'</span>'+(o.deltaUnit || "");
    dpctc = '<span style="color:var('+vr+')">'+_pct(o.dpct)+'</span>';
  }
  var pcell;
  if (isnan(p)) pcell = "–";
  else { var ptxt = p >= 1e-4 ? _g2(p) : _e0(p);
    pcell = sig ? '<span class="psig">'+ptxt+'</span>' : '<span class="pns">'+ptxt+'</span>'; }
  // Dim only the difference columns (Δ / Δ% / p) when not significant; the A/B values stay lit.
  var dc = sig ? "" : ' class="dim"';
  return '<tr><td class="l stage">'+o.label+'</td><td>'+a+'</td><td>'+b+'</td><td'+dc+'>'+dcell
       + '</td><td'+dc+'>'+dpctc+'</td><td class="pcol'+(sig?"":" dim")+'">'+pcell+'</td></tr>';
}
// Elapsed to reach each download % per arm. 'both' shows A|B|Δ|Δ%|p; a single arm shows
// just that arm's elapsed. Less time is better (negative Δ green).
function time_to_stall_table(ctx, armMode?){
  if (!ctx.dual || !ctx.time_to_stall.length) return "";
  var la = ctx.control_label, lb = ctx.experiment_label;
  var both = (armMode === undefined || armMode === 'both');
  var secCell = function(v, sd, n){ if (v === null || v === undefined) return "–";
    var s = (n > 1) ? '<span class="sd">±'+(sd||0).toFixed(0)+'</span>' : "";
    return '<span class="pval">'+v.toFixed(0)+'</span><span class="unit">s</span>'+s; };
  var out = [_dlHead("Progress", both, la, lb, armMode, " elapsed", "Δ s")];
  ctx.time_to_stall.forEach(function(r){
    out.push(_dlRow({label:r.pct+'%', both:both, armMode:armMode,
      a:r.a, aStd:r.a_std, b:r.b, bStd:r.b_std, nCtl:ctx.n_ctl, nExp:ctx.n_exp,
      d:r.dsec, dpct:r.dpct, p:r.p, goodPos:false,
      fmtVal:secCell, deltaVal:function(d){return _sms(d);}, deltaUnit:""}));
  });
  out.push('</tbody></table>');
  return out.join("");
}
// Download throughput (MB/s): avg + peak rows. More MB/s is better (positive Δ green). The
// values are already per-node (mb_per_s is the cluster-wide free-space delta ALREADY divided
// by #nodes — same source as the download chart's MB/s axis), so shown as-is; nd only picks
// the unit wording.
function mbps_table(ctx, armMode?){
  if (!ctx.dual || !ctx.mbps_rows || !ctx.mbps_rows.length) return "";
  var la = ctx.control_label, lb = ctx.experiment_label;
  var both = (armMode === undefined || armMode === 'both');
  var nd = (ctx.nodes && ctx.nodes > 0) ? ctx.nodes : null;
  var unit = 'MB/s', unitSpan = '<span class="unit">'+unit+'</span>';
  // The rate is per-node; say so once on the row label ("avg MB/s" -> "avg MB/s/node")
  // instead of repeating "/node" on every value cell.
  var rowLabel = function(lbl){ return esc(lbl) + ((nd && nd > 1) ? '/node' : ''); };
  var valCell = function(v, sd, n){ if (v === null || v === undefined) return "–";
    var s = (n > 1) ? '<span class="sd">±'+_num(sd||0)+'</span>' : "";
    return '<span class="pval">'+_num(v)+'</span>'+unitSpan+s; };
  var out = [_dlHead("throughput", both, la, lb, armMode, "", "Δ")];
  ctx.mbps_rows.forEach(function(r){
    out.push(_dlRow({label:rowLabel(r.label), both:both, armMode:armMode,
      a:r.a, aStd:r.a_std, b:r.b, bStd:r.b_std, nCtl:ctx.n_ctl, nExp:ctx.n_exp,
      d:r.d, dpct:r.dpct, p:r.p, goodPos:true,
      fmtVal:valCell, deltaVal:function(d){return _sms(d);}, deltaUnit:unitSpan}));
  });
  out.push('</tbody></table>');
  return out.join("");
}

// Progress-distribution summary: the "max delta" = each run's PEAK max−min remaining-bytes
// spread across nodes (the worst node-skew moment), averaged per arm ±std, with the A/B
// difference — computed here from the skew series (ctx.series), so analyze() is untouched.
// Below the row, a link reveals the full distribution chart. Lower skew is better (green Δ).
// Shared fixed column widths so the A/B/Δ/Δ%/p columns line up across the three stacked
// download tables (throughput / progress / distribution), whose first-column labels differ.
function _dlcols(both){
  return both
    ? '<colgroup><col style="width:27%"><col style="width:18%"><col style="width:18%"><col style="width:13%"><col style="width:13%"><col style="width:11%"></colgroup>'
    : '<colgroup><col style="width:27%"><col></colgroup>';
}
function _mbUnit(vals){   // pick MB/GB/TB for a set of byte magnitudes
  var mx = 0; vals.forEach(function(v){ if (v != null && Math.abs(v) > mx) mx = Math.abs(v); });
  if (mx >= 1048576) return { unit: "TB", div: 1048576 };
  if (mx >= 1024) return { unit: "GB", div: 1024 };
  return { unit: "MB", div: 1 };
}
function pdist_table(ctx, armMode?){
  if (!ctx.dual) return "";
  var s0 = ctx.series && (ctx.series.agg || (ctx.op_order && ctx.series[ctx.op_order[0]]));
  if (!s0 || !s0.rDeltaRuns) return "";
  var peaks = function(arm){
    var runs = s0.rDeltaRuns[arm] || [], out = [];
    runs.forEach(function(r){ if (!r || !r.length) return;
      var mx = null; for (var i=0;i<r.length;i++){ var y=r[i].y; if (y!=null && (mx==null || y>mx)) mx=y; }
      if (mx != null) out.push(mx); });
    return out;
  };
  var cv = peaks("ctl"), ev = peaks("exp");
  if (!cv.length && !ev.length) return "";
  var cs = _summ(cv), es = _summ(ev);
  var mw = (cv.length && ev.length) ? mann_whitney(cv, ev) : [NAN, NAN, "none"];
  var d = (cs.mean != null && es.mean != null) ? es.mean - cs.mean : null;
  var dpct = (d != null && cs.mean) ? d / cs.mean * 100.0 : null;
  var la = ctx.control_label, lb = ctx.experiment_label, both = (armMode === undefined || armMode === "both");
  var u = _mbUnit([cs.mean, es.mean, d]);
  var valCell = function(v, sd, n){ if (v == null) return "–";
    var s = (n > 1) ? '<span class="sd">±'+_num((sd||0)/u.div)+'</span>' : "";
    return '<span class="pval">'+_num(v/u.div)+'</span><span class="unit">'+u.unit+'</span>'+s; };
  var link = ' <a class="showgraph" data-pdist-show href="#" title="show the per-node distribution over time"></a>';
  var out = [_dlHead("progress distribution", both, la, lb, armMode, "", "Δ")];
  out.push(_dlRow({label:'max delta'+link, both:both, armMode:armMode,
    a:cs.mean, aStd:cs.std, b:es.mean, bStd:es.std, nCtl:ctx.n_ctl, nExp:ctx.n_exp,
    d:d, dpct:dpct, p:(mw[1] as number), goodPos:false,   // less node skew is better
    fmtVal:valCell, deltaVal:function(dd){return _sms(dd/u.div);},
    deltaUnit:'<span class="unit">'+u.unit+'</span>'}));
  out.push('</tbody></table>');
  return out.join("");
}
// The download tables, stacked: throughput (MB/s), progress (elapsed-to-download-%), and the
// progress-distribution summary. Each carries its own header, so just a gap between them.
// Shared by render_body and refreshTables so order stays in sync on re-render.
function download_tables(ctx, armMode?){
  var parts = [mbps_table(ctx, armMode), time_to_stall_table(ctx, armMode), pdist_table(ctx, armMode)]
    .filter(function(t){ return !!t; });
  return parts.join('<div class="tblgap"></div>');
}

export { _avg, _group_cells, _dlCrossT, _rowTimeRun, _time_cell, _dl_cell, op_time_table, prov_table, time_to_stall_table, mbps_table, download_tables };
