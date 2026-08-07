// HTML table generators (cells, op tables, time tables, provenance, throughput).
import { esc, _num, _pct, _sms, fmtSizeMB } from "../format/format";
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
// arm key -> role letter (used for data-arm attributes and armMode filtering).
var LETTER = {ctl:'A', exp:'B', c:'C'};
// Graded delta dimming by p: full at significant (p<=ALPHA), slightly dimmed when marginal
// (ALPHA<p<0.2), more dimmed when weak (p>=0.2 or no test). Softer than a binary keep/grey.
function _dimClass(p){
  if (isnan(p)) return " dim2";
  if (p <= ALPHA) return "";
  return p < 0.2 ? " dim1" : " dim2";
}
// p to two decimals, leading zero stripped (".13", ".05"); "<.01" when it rounds to zero.
function _p2(p){
  if (p === null || p === undefined || isnan(p)) return "–";
  if (p < 0.005) return "<.01";
  var s = p.toFixed(2);
  return s.charAt(0) === "0" ? s.slice(1) : s;
}
// A latency cell's delta: relative Δ% (colored good/bad) + p, dimmed when not significant.
// `d` = {delta_mean, delta_mean_pct, p}. goodPos flips which direction is green.
function _delta_cell(d, metric, goodPos){
  var dm_ids = 'data-metric="'+metric+'"';
  var p = d.p, sig = (!isnan(p) && p < ALPHA), dimc = _dimClass(p);
  var dm = d.delta_mean, dmp = d.delta_mean_pct;
  if (dmp === null || dmp === undefined || isnan(p)) return '<td class="dcell'+dimc+'" '+dm_ids+'>–</td>';
  var vr = (goodPos ? (dm > 0) : (dm < 0)) ? "--good" : "--bad";
  var pcls = sig ? "psig" : "pns";
  return '<td class="dcell'+dimc+'" '+dm_ids+'>'
    + '<span class="dval" style="color:var('+vr+')">'+_pct(dmp)+'</span>'
    + '<span class="pv '+pcls+'">p='+_p2(p)+'</span></td>';
}
// opts (optional): {unit:"ms"|"%", higherBetter:bool}. Default is latency-style — unit "ms"
// and lower-is-better (a negative delta is the "good" green). The download column passes
// {unit:"%", higherBetter:true} so more-downloaded is green.
// Renders one metric group's cells for N arms, interleaved so each non-baseline arm sits next
// to its own delta vs the baseline (arm 0): A | B | Δ(A-B) | C | Δ(A-C). `st` = _statsN() output
// {arms:[{s}], cmp:[{delta…,p}]}. A single arm renders just its value cell. opts.valuesOnly emits
// only the per-arm values (no delta columns) — used for the download % in the latency tables,
// where the download reading is per-row context for the latency, not a compared metric.
function _group_cells(st, op, metric, stage_pct, opts?){
  opts = opts || {}; var unit = opts.unit || "ms"; var goodPos = !!opts.higherBetter;
  var ids = 'data-op="'+op+'" data-metric="'+metric+'" data-stage="'+stage_pct+'"';
  var arms = st.arms, cmp = st.cmp;
  if (arms.length === 1)
    return '<td class="vcell" data-arm="'+(LETTER[arms[0].key]||'A')+'" '+ids+'>'+_avg(arms[0].s,unit)+'</td>';
  // Only the delta cells dim when a difference isn't significant — the per-arm values stay lit.
  var out = "";
  for (var i=0;i<arms.length;i++){
    out += '<td class="vcell'+(i===0?' grpl':'')+'" data-arm="'+(LETTER[arms[i].key]||'')+'" '+ids+'>'+_avg(arms[i].s,unit)+'</td>';
    if (i>0 && !opts.valuesOnly) out += _delta_cell(cmp[i-1], metric, goodPos);
  }
  return out;
}
// Elapsed at which to read run `i` of `arm` for this row: a fixed time, or that
// run's own download-complete (+60s for done+1m). null if the run never completed.
function _rowTimeRun(sop, arm, i, row){
  if (!row.special) return row.t;
  var comp = _dlCrossT((sop.dlRuns[arm]||[])[i], 100);
  return comp==null ? null : (row.special==="done1m" ? comp+60 : comp);
}
// N-arm summary/MWU stats over per-arm value lists (arm 0 = baseline). Returns per-arm
// summaries + one pairwise comparison (Δmean, Δ%, MWU p) of each later arm vs the baseline,
// shaped for _group_cells (A | B | Δ(A-B) | C | Δ(A-C)). Deltas are baseline-relative — the
// same two-sample math as the old A-vs-B, just applied per non-baseline arm.
function _statsN(per){
  var arms = per.map(function(p){ return {key:p.key, s:_summ(p.vals), vals:p.vals}; });
  var base = arms[0], cmp = [];
  for (var i=1;i<arms.length;i++){ var e = arms[i];
    var mw = (base.vals.length && e.vals.length) ? mann_whitney(base.vals, e.vals) : [NAN, NAN, "none"];
    var dm = (base.s.mean!=null && e.s.mean!=null) ? e.s.mean-base.s.mean : null;
    var dmp = (dm!=null && base.s.mean) ? dm/base.s.mean*100.0 : null;
    cmp.push({p:mw[1], delta_mean:dm, delta_mean_pct:dmp});
  }
  return {arms:arms, cmp:cmp};
}
function _time_cell(sop, metric, row, shown){
  function vals(arm){ var rr = sop.elRuns[arm+"_"+metric]||[];
    return rr.map(function(pl,i){ var t=_rowTimeRun(sop,arm,i,row); return t==null?null:_iXY(pl,t); })
             .filter(function(v){return v!=null;}); }
  return _statsN(shown.map(function(a){ return {key:a, vals:vals(a)}; }));
}
// Per-run download % reached by the row's time. On the special rows every run is 100% by
// construction (each is anchored at its own completion).
function _dl_cell(sop, row, shown){
  function vals(arm){ var rr = sop.dlRuns[arm]||[];
    var out = row.special ? rr.map(function(){ return 100; }) : rr.map(function(pl){ return _iXY(pl, row.t); });
    return out.filter(function(v){return v!=null;}); }
  return _statsN(shown.map(function(a){ return {key:a, vals:vals(a)}; }));
}
// armKeys = every arm present (['ctl'] | ['ctl','exp'] | ['ctl','exp','c']); armLabels maps
// arm key -> display label; armMode ('both'|'A'|'B'|'C') optionally isolates one arm.
function op_time_table(op, sop, armKeys, armLabels, timeRows, armMode?){
  var shown = (armMode && armMode!=="both") ? armKeys.filter(function(a){ return LETTER[a]===armMode; }) : armKeys;
  if (!shown.length) shown = [armKeys[0]];
  var multi = shown.length>1;
  // The download % is per-row context for the latency, not a compared metric here — show one
  // value per arm, no delta columns (the real download comparison is in the download tables).
  var dlOpts = {unit:"%", higherBetter:true, valuesOnly:true};
  var cols = ["download"].concat(MAIN_METRICS);
  var span = function(m){ return m==="download" ? shown.length : 2*shown.length-1; };
  var out = ['<table class="tbl">'];
  // Every delta is baseline-relative (vs arm A). With >2 arms two bare "Δ" columns are
  // ambiguous, so name the baseline; with 2 arms a single "Δ" is unambiguous. (The p-value
  // rides in the cell, so the header drops it.)
  var dhdr = shown.length>2 ? ('Δ vs '+esc(armLabels[shown[0]]||shown[0])) : 'Δ';
  if (multi){
    out.push('<thead><tr><th class="l" rowspan="2">time</th>');
    cols.forEach(function(m){ out.push('<th colspan="'+span(m)+'" class="grp" data-metric="'+m+'">'+m+'</th>'); });
    out.push('</tr><tr>');
    cols.forEach(function(m){
      shown.forEach(function(a,i){
        out.push('<th'+(i===0?' class="grpl"':'')+' data-metric="'+m+'">'+esc(armLabels[a]||a)+'</th>');
        if (i>0 && m!=="download") out.push('<th data-metric="'+m+'">'+dhdr+'</th>');
      });
    });
    out.push('</tr></thead><tbody>');
  } else {
    var lab = armLabels[shown[0]] || shown[0];
    out.push('<thead><tr><th class="l">time</th>');
    cols.forEach(function(m){ out.push('<th data-metric="'+m+'">'+m+(armKeys.length>1?' <span class="muted">('+esc(lab)+')</span>':'')+'</th>'); });
    out.push('</tr></thead><tbody>');
  }
  timeRows.forEach(function(row){
    var stageId = (row.t != null ? row.t : row.special);
    out.push('<tr><td class="l stage">'+esc(row.label)+'</td>');
    out.push(_group_cells(_dl_cell(sop, row, shown), op, "download", stageId, dlOpts));
    MAIN_METRICS.forEach(function(metric){
      out.push(_group_cells(_time_cell(sop, metric, row, shown), op, metric, stageId));
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
  // Cluster/dataset shape. Both come off the run bodies (node count = how many per-node
  // download columns; size = metadata.total_bytes, the data the restore landed) — never parsed
  // out of the opaque test name — and each is shown only when some arm reports it. Separate
  // rows so a shared node
  // count still merges when the dataset sizes differ, and vice versa.
  if (details.some(function(pair){ return pair[1].nodes != null; }))
    out.push(row("nodes", function(d){return d.nodes != null ? esc(d.nodes) : "—";},
      function(d){return d.nodes != null ? String(d.nodes) : "";}));
  if (details.some(function(pair){ return pair[1].total_mb != null; }))
    out.push(row("data size", function(d){return esc(fmtSizeMB(d.total_mb) || "—");}));
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
// ---- Shared N-arm download-table scaffolding (throughput / progress / distribution) ----
// These three download tables share a header + row shape; only the value formatting, the
// good-delta direction, and the row labels differ. Columns interleave like the latency tables:
// A | B | Δ(A-B) | C | Δ(A-C), each delta a self-describing "−12% (−8s, p=.34)" cell.
// The arms actually shown (all, or one when armMode isolates it).
function _dlShown(ctx, armMode){
  var armKeys = ctx.armKeys || ["ctl"].concat(ctx.dual ? ["exp"] : []);
  var shown = (armMode && armMode !== 'both') ? armKeys.filter(function(a){ return LETTER[a]===armMode; }) : armKeys;
  if (!shown.length) shown = [armKeys[0]];
  return {armKeys:armKeys, shown:shown};
}
// Shared fixed widths so the columns line up across the three stacked tables. n = shown arms;
// layout is label + per arm (value, plus a delta for every arm past the baseline).
function _dlcols(n){
  if (n <= 1) return '<colgroup><col style="width:27%"><col></colgroup>';
  var valW = n>=3?13:20, delW = n>=3?18:38, g = '<colgroup><col style="width:22%">';
  for (var i=0;i<n;i++){ g += '<col style="width:'+valW+'%">'; if (i>0) g += '<col style="width:'+delW+'%">'; }
  return g + '</colgroup>';
}
function _dlHead(title, shown, labels, valSuffix){
  // Name the baseline in the Δ header when >2 arms (two bare "Δ"s would be ambiguous).
  var dhdr = shown.length>2 ? ('Δ vs '+esc(labels[shown[0]]||shown[0])) : 'Δ';
  var out = '<table class="tbl dlt">'+_dlcols(shown.length)+'<thead><tr><th class="l">'+title+'</th>';
  shown.forEach(function(a,i){ out += '<th>'+esc(labels[a]||a)+valSuffix+'</th>'; if (i>0) out += '<th>'+dhdr+'</th>'; });
  return out + '</tr></thead><tbody>';
}
// One collapsed download delta cell: relative Δ% (colored) + (abs delta, p) parenthetical.
// `d` = {d, dpct, p}. Dims when not significant.
function _dlDelta(d, goodPos, deltaVal, deltaUnit){
  var p = d.p, sig = (!isnan(p) && p < ALPHA), dc = ' class="dcell'+_dimClass(p)+'"';
  if (d.d === null || d.d === undefined) return '<td'+dc+'>–</td>';
  var vr = (goodPos ? (d.d > 0) : (d.d < 0)) ? "--good" : "--bad";
  var absStr = deltaVal(d.d) + (deltaUnit || "");
  var pcls = sig ? "psig" : "pns", pTxt = isnan(p) ? "" : ("p=" + _p2(p));
  var sub = '(' + absStr + (pTxt ? (', <span class="'+pcls+'">'+pTxt+'</span>') : '') + ')';
  return '<td'+dc+'><span class="dval" style="color:var('+vr+')">'+_pct(d.dpct)+'</span><span class="dsub">'+sub+'</span></td>';
}
// o: {label, arms:[{v,std,n}], cmp:[{d,dpct,p}], goodPos, fmtVal(v,sd,n,i)->cell (i = column
//     index among the SHOWN arms), deltaVal(d)->str, deltaUnit, cls?} — cls is an extra class
//     on the label cell (e.g. " mstone").
function _dlRow(o){
  var cells = "";
  for (var i=0;i<o.arms.length;i++){ var A = o.arms[i];
    cells += '<td>'+o.fmtVal(A.v, A.std, A.n, i)+'</td>';
    if (i>0) cells += _dlDelta(o.cmp[i-1], o.goodPos, o.deltaVal, o.deltaUnit);
  }
  return '<tr><td class="l stage'+(o.cls||"")+'">'+o.label+'</td>'+cells+'</tr>';
}
// Filter an analyze row ({arms,cmp} over ALL arms) down to the shown arms: all -> as-is; a
// single isolated arm -> just its value, no deltas.
function _dlPick(row, armKeys, shown){
  if (shown.length === armKeys.length) return {arms:row.arms, cmp:row.cmp};
  var j = armKeys.indexOf(shown[0]);
  return {arms:[row.arms[j]], cmp:[]};
}
// Elapsed to reach each point of the restore, per arm + each non-baseline arm's Δ vs A. Less
// time is better (negative Δ green). Two kinds of row share the table: the download-%
// crossings, and the optional usability milestones from the run's `timings` block
// (available / functional / healthy). They are one timeline, so they interleave in
// chronological order of the BASELINE arm's mean rather than being stacked in two blocks — a
// milestone is only meaningful next to how far the download had got. Milestone labels carry
// an extra class so they still read as a different kind of row. `restored` gets no row of its
// own: the 100% crossing IS it, and says so.
//
// Each value also carries that elapsed normalized by the run's own dataset — minutes per TB per
// node (row.cost, absent when a run reports no size/node count). That is what makes this one
// table enough: every milestone's cost sits next to its wall clock, so the throughput table
// needs no row for it, and the completion row's cost is the `restored` throughput with the
// terms rearranged. The Δ column compares the NORMALIZED values whenever they exist (see
// _progress_row) — seconds alone don't compare across arms that moved different amounts of
// data — and falls back to comparing seconds when they don't.
function time_to_stall_table(ctx, armMode?){
  // The 100% crossing is the completion marker, so name it as one.
  var pctLabel = function(pct){ return pct >= 100 ? '100% restored' : (pct+'%'); };
  var rows = (ctx.time_to_stall || []).map(function(r){ return {label:pctLabel(r.pct), cls:"", row:r}; })
    .concat((ctx.milestones || []).map(function(r){ return {label:esc(r.label), cls:" mstone", row:r}; }));
  if (!rows.length) return "";
  // Rows with no baseline reading sort last, keeping their declared order among themselves.
  rows.forEach(function(e, i){
    var a0 = e.row.arms[0];
    e.k = (a0 && a0.v != null) ? a0.v : Infinity;
    e.i = i;
  });
  rows.sort(function(a, b){ return (a.k - b.k) || (a.i - b.i); });
  var S = _dlShown(ctx, armMode);
  var costUnit = 'min/TB'+((ctx.nodes && ctx.nodes > 1) ? '/node' : '');
  // The seconds, then (when the row is normalizable) the same instant as a size-normalized cost.
  var secCell = function(cost){ return function(v, sd, n, i){
    if (v === null || v === undefined) return "–";
    var s = (n > 1) ? '<span class="sd">±'+(sd||0).toFixed(0)+'</span>' : "";
    var cv = cost ? cost.arms[i].v : null;
    var sub = (cv != null) ? '<span class="dsub">('+_num(cv)+' '+costUnit+')</span>' : "";
    return '<span class="pval">'+v.toFixed(0)+'</span><span class="unit">s</span>'+s+sub; }; };
  var out = [_dlHead("Progress", S.shown, ctx.labels, " elapsed")];
  rows.forEach(function(e){
    var pk = _dlPick(e.row, S.armKeys, S.shown);
    // Compare normalized where we can, seconds otherwise — the Δ unit follows.
    var ct = e.row.cost ? _dlPick(e.row.cost, S.armKeys, S.shown) : null;
    out.push(_dlRow({label:e.label, cls:e.cls, arms:pk.arms, cmp:(ct ? ct.cmp : pk.cmp), goodPos:false,
      fmtVal:secCell(ct), deltaVal:function(d){return _sms(d);},
      deltaUnit:'<span class="unit">'+(ct ? costUnit : 's')+'</span>'}));
  });
  out.push('</tbody></table>');
  return out.join("");
}
// Download throughput (MB/s). More MB/s is better (positive Δ green). Every value is
// per-node: the disk rows come from the generator already divided by nodes (same source as
// the download chart's MB/s axis), and `restored` divides by the node count in analyze(). So
// the unit — not the row label — carries the "/node", and every row in the column is directly
// comparable.
//
// Rows, in analyze() order: `restored` (dataset / wall clock to restored / node — the honest
// headline), then the raw `disk avg rate` / `disk peak rate` write rates, which only cover the
// intervals in which the disk was writing and so run ahead of the restored figure. Every row
// here is real byte movement; the usability milestones are not, and stay in the progress table
// as elapsed + min/TB/node (the same quantity as `restored`, rearranged).
function mbps_table(ctx, armMode?){
  if (!ctx.mbps_rows || !ctx.mbps_rows.length) return "";
  var S = _dlShown(ctx, armMode);
  var nd = (ctx.nodes && ctx.nodes > 0) ? ctx.nodes : null;
  var unitSpan = '<span class="unit">MB/s'+((nd && nd > 1) ? '/node' : '')+'</span>';
  var valCell = function(v, sd, n){ if (v === null || v === undefined) return "–";
    var s = (n > 1) ? '<span class="sd">±'+_num(sd||0)+'</span>' : "";
    return '<span class="pval">'+_num(v)+'</span>'+unitSpan+s; };
  var out = [_dlHead("throughput", S.shown, ctx.labels, "")];
  ctx.mbps_rows.forEach(function(r){ var pk = _dlPick(r, S.armKeys, S.shown);
    out.push(_dlRow({label:esc(r.label), arms:pk.arms, cmp:pk.cmp, goodPos:true,
      fmtVal:valCell, deltaVal:function(d){return _sms(d);}, deltaUnit:unitSpan}));
  });
  out.push('</tbody></table>');
  return out.join("");
}
function _mbUnit(vals){   // pick MB/GB/TB for a set of byte magnitudes
  var mx = 0; vals.forEach(function(v){ if (v != null && Math.abs(v) > mx) mx = Math.abs(v); });
  if (mx >= 1048576) return { unit: "TB", div: 1048576 };
  if (mx >= 1024) return { unit: "GB", div: 1024 };
  return { unit: "MB", div: 1 };
}
// Progress-distribution summary: initial skew + each run's PEAK max−min remaining-bytes spread,
// averaged per arm with each non-baseline arm's Δ vs A — computed here from the skew series
// (ctx.series), so analyze() is untouched. Below the max-delta row, a link reveals the full chart.
function pdist_table(ctx, armMode?){
  var s0 = ctx.series && (ctx.series.agg || (ctx.op_order && ctx.series[ctx.op_order[0]]));
  if (!s0 || !s0.rDeltaRuns) return "";
  var S = _dlShown(ctx, armMode);
  var peaks = function(arm){
    var runs = s0.rDeltaRuns[arm] || [], out = [];
    runs.forEach(function(r){ if (!r || !r.length) return;
      var mx = null; for (var i=0;i<r.length;i++){ var y=r[i].y; if (y!=null && (mx==null || y>mx)) mx=y; }
      if (mx != null) out.push(mx); });
    return out;
  };
  // Initial skew: at the FIRST sample, the across-node spread (max−min = rdelta) as a % of the
  // across-node mean (rmean), per run, averaged per arm. Captures how unevenly the download starts.
  var initSkew = function(arm){
    var dr = (s0.rDeltaRuns && s0.rDeltaRuns[arm]) || [], mr = (s0.rMeanRuns && s0.rMeanRuns[arm]) || [], o = [];
    for (var i=0;i<dr.length;i++){
      var dd = dr[i], mm = mr[i];
      if (!dd || !dd.length || !mm || !mm.length) continue;
      var delta = dd[0].y, mean = mm[0].y;
      if (delta == null || mean == null || !mean) continue;
      o.push(delta / mean * 100.0);
    }
    return o;
  };
  if (!S.armKeys.some(function(a){ return peaks(a).length; })) return "";
  // Baseline-relative stats over the shown arms for a per-arm value fn.
  var statN = function(fn){
    var per = S.shown.map(function(a){ var v = fn(a); return {vals:v, s:_summ(v)}; });
    var base = per[0], cmp = per.slice(1).map(function(e){
      var mw = (base.vals.length && e.vals.length) ? mann_whitney(base.vals, e.vals) : [NAN, NAN, "none"];
      var d = (base.s.mean!=null && e.s.mean!=null) ? e.s.mean-base.s.mean : null;
      var dpct = (d!=null && base.s.mean) ? d/base.s.mean*100.0 : null;
      return {d:d, dpct:dpct, p:mw[1]};
    });
    return {per:per, cmp:cmp};
  };
  var toArms = function(st){ return st.per.map(function(e){ return {v:e.s.mean, std:e.s.std, n:e.vals.length}; }); };
  var mx = statN(peaks), sk = statN(initSkew);
  var mags = []; mx.per.forEach(function(e){ mags.push(e.s.mean); }); mx.cmp.forEach(function(c){ mags.push(c.d); });
  var u = _mbUnit(mags);
  var valCell = function(v, sd, n){ if (v == null) return "–";
    var s = (n > 1) ? '<span class="sd">±'+_num((sd||0)/u.div)+'</span>' : "";
    return '<span class="pval">'+_num(v/u.div)+'</span><span class="unit">'+u.unit+'</span>'+s; };
  var pctCell = function(v, sd, n){ if (v == null) return "–";
    var s = (n > 1) ? '<span class="sd">±'+_num(sd||0)+'</span>' : "";
    return '<span class="pval">'+_num(v)+'</span><span class="unit">%</span>'+s; };
  var link = ' <a class="showgraph" data-pdist-show href="#" title="show the per-node distribution over time"></a>';
  var out = [_dlHead("progress distribution", S.shown, ctx.labels, "")];
  out.push(_dlRow({label:'initial skew', arms:toArms(sk), cmp:sk.cmp, goodPos:false,   // less starting skew is better
    fmtVal:pctCell, deltaVal:function(dd){return _sms(dd);}, deltaUnit:'<span class="unit">%</span>'}));
  out.push(_dlRow({label:'max delta'+link, arms:toArms(mx), cmp:mx.cmp, goodPos:false,   // less node skew is better
    fmtVal:valCell, deltaVal:function(dd){return _sms(dd/u.div);}, deltaUnit:'<span class="unit">'+u.unit+'</span>'}));
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
