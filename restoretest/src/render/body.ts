// Body HTML: assembles the report shell (details + one continuous dashboard: the Restore
// header/graph and the Latency header/op-charts). The Restore header + progress graph and the
// Latency header are made sticky by CSS (they pin as you scroll through the op-charts).
import { esc } from "../format/format";
import { prov_table, op_time_table, download_tables } from "./tables";
import { bake_svg } from "./svg";

function render_body(ctx){
  var dual = ctx.dual, cl = ctx.control_label, el = ctx.experiment_label;
  var op_order = ctx.op_order;
  var multiRun = Math.max(ctx.n_ctl || 0, ctx.n_exp || 0) > 1;
  var A = [];
  A.push("<div class='report'>");
  // No "Details" heading: the arm ribbon (prepended in bootstrap) is the card's header strip,
  // sitting flush on top of this section so the two read as one card (see .armbar / .details CSS).
  A.push("<section class='details'>");
  A.push(prov_table(ctx));
  A.push("</section>");

  // Series-presence flags shared by the sub-containers below.
  var s0 = ctx.series && (ctx.series.agg || ctx.series[op_order[0]]);
  var hasDl = !!(s0 && s0.dl && Object.keys(s0.dl).some(function(a){ return (s0.dl[a]||[]).length; }));
  var hasRemote = !!(s0 && s0.rMean && Object.keys(s0.rMean).some(function(a){ return (s0.rMean[a]||[]).length; }));
  var dltbl = download_tables(ctx);
  var hasRestore = (hasDl || dltbl || hasRemote);

  // Global chart controls — they drive EVERY chart (x-axis mode; summary vs per-run; zoom
  // reset). They live in their own right-aligned bar (.stick-gctrl) pinned directly under the
  // compact progress graph; the Latency header slides up to its LEFT and overlays it (the
  // Latency header is transparent with click-through on its empty right — the split ribbon).
  var globalCtrls = "<span class='seg'>"
    + "<button data-xmode='elapsed' class='on'>elapsed</button>"
    + "<button data-xmode='pct'>% downloaded</button></span>";
  if (multiRun) globalCtrls += "<span class='seg'><button data-plot='avg' class='on'>summary</button>"
    + "<button data-plot='all'>runs</button></span>";
  globalCtrls += "<button class='unzoom' data-unzoom title='reset zoom (or press Esc)' aria-label='reset zoom'>⤢</button>";

  // One continuous surface so the sticky headers/graph pin across the whole scroll (plain
  // position:sticky only holds within a single container — hence no separate section cards).
  A.push("<div class='dash'>");

  if (hasRestore){
    // The Restore title is NOT sticky (nothing sits to its right); it scrolls away and the
    // compact graph pins to the very top instead.
    A.push("<div class='ctrl header resthdr'><span class='htitle'>Restore Progress</span></div>");
    // Zero-height marker just above the graph. The 'stuck' (compact) toggle keys off THIS
    // element scrolling under the pinned header — not the graph's own moving box — so shrinking
    // the graph can't feed back into the decision (which otherwise oscillates vs scroll-anchoring).
    A.push("<div class='stick-sentinel' aria-hidden='true'></div>");
    // Wrapper is the sticky/squishing element; the inner .dlchart is the chart-JS render
    // target, and .dlcap is an HTML overlay for the y1 (left-axis) cursor readout — kept
    // readable while the SVG (and its own labels) are squished flat in the compact strip.
    A.push("<div class='stick stick-graph'><div class='chart dlchart' data-dl='1'></div>"
      + "<div class='dlcap' data-dlcap></div></div>");
    // The global-controls bar: pinned directly under the compact graph, above the tables.
    A.push("<div class='ctrl stick stick-gctrl'>"+globalCtrls+"</div>");
    if (dltbl){
      // Wrapped so refreshTables can re-render both tables on arm change (like the op tables).
      A.push("<div class='dltbl'>"+dltbl+"</div>");
    }
    if (hasRemote){
      // Per-node progress-distribution chart, collapsed by default — click its title to expand.
      // Its series toggles live by the title (specific to this one plot) and hide while collapsed.
      A.push("<div class='pdist collapsed'>");
      A.push("<div class='ctrl gtitle'><span class='gtitletxt' data-pdist-toggle>Progress Distribution</span><span class='seg'>");
      A.push("<button data-remote-min class='on'>min</button>");
      A.push("<button data-remote-mean>mean</button>");
      A.push("<button data-remote-max class='on'>max</button></span><span class='seg'>");
      A.push("<button data-remote-delta class='on'>delta</button>");
      A.push("<button data-remote-ratio>delta-ratio</button></span></div>");
      A.push("<div class='chart' data-remote='1'></div>");
      A.push("</div>");
    }
  }

  function op_heading(op){
    if (op === "agg") return "Overall Workload Latency";
    return op[0].toUpperCase()+op.slice(1)+" Query Latency";
  }
  // A plain (non-sticky) rule separating the Restore info section above from the Latency section.
  A.push("<hr class='sec-sep'>");
  // Latency header: title + metric/scale controls (one bar for every op chart below). It's a
  // transparent overlay that pins at the SAME level as the global-controls bar and slides up to
  // its LEFT (the split ribbon). With no Restore section it also hosts the global controls.
  A.push("<div class='ctrl header stick stick-latency'><span class='htitle'>Workload Latency</span><span class='seg'>");
  A.push("<button data-pct='p50' class='on'>p50</button>");
  A.push("<button data-pct='p95'>p95</button>");
  A.push("<button data-pct='p99' class='on'>p99</button>");
  A.push("<button data-qps>qps</button></span>");
  A.push("<span class='seg'>");   // linear/log
  A.push("<button data-scale='linear' class='on'>linear</button>");
  A.push("<button data-scale='log'>log</button></span>");
  if (!hasRestore) A.push(globalCtrls);   // no Restore section -> host the global controls here
  A.push("</div>");
  op_order.forEach(function(op){
    var big = (op === "agg");
    A.push("<h3>"+esc(op_heading(op))+"</h3>");
    A.push("<div class='chart' data-op='"+esc(op)+"' data-big='"+(big?1:0)+"'>"
      + bake_svg(op, ctx.series[op], big) + "</div>");
    A.push("<div class='optbl' data-op='"+esc(op)+"'>"+op_time_table(op, ctx.series[op], ctx.armKeys, ctx.labels, ctx.timeRows)+"</div>");
  });

  A.push("</div>");   // .dash
  A.push("</div>");   // .report
  return A.join("");
}

export { render_body };
