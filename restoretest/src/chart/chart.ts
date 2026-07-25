// Deferred so it runs AFTER the DOM shell is built and the render context (RC) is passed.
// Shared helpers (deduped from the core/format layers):
import { _nice_step as niceStep } from "../format/format";
import { _iXY as interp2, _dlCrossT } from "../compute/interp";
import { copyText } from "../clipboard";
import { op_time_table, download_tables } from "../render/tables";

// ---- Run isolation: transient hover + sticky pin (all-runs mode) ------------------------
// Isolating one run bolds it across EVERY chart (the rest dim) and switches the synced cursor
// to that run's series + names it in the header, so a download-rate dip and a latency spike
// can be read off the same run at the same x. Two ways to isolate, PIN taking precedence:
//   HOVER — the run under the pointer (transient; clears when you roll off the line).
//   PIN   — a run pinned by clicking it: stays isolated while you scrub other times, and a
//           plain click clears it. `isoRun()` = PIN ?? HOVER is what everything reads.
// These are module-scope because the hover listeners are delegated ONCE (they must survive
// chart re-renders) while the per-render cursor closures and click handler read/set them.
let HOVER: { arm: string; idx: number } | null = null;
let PIN: { arm: string; idx: number } | null = null;
// Each render publishes how to repaint its cursor at the last x (so isolation changes refresh
// the labels immediately even with the pointer resting still) and how to reset the zoom (so
// the once-bound Escape key can reach the current render's handler).
let ACTIVE: { redrawCursor: () => void; resetZoom: () => void } | null = null;
// runChart re-runs on every arm pick/un-pick/compare/remove, and each run wires up a set of
// document-level pointer/keyboard listeners that close over THAT render's state + CURSORS.
// They must not accumulate (stale closures would double-fire clicks, redraw from old data,
// etc.), so every per-render listener is tied to this controller's signal and the previous
// render's controller is aborted at the top of the next runChart. (The installRunHover
// listeners above are deliberately module-scope and outlive renders, so they get no signal.)
let RENDER_AC: AbortController | null = null;
// Sticky control defaults shared with the bootstrap slug logic (which diffs against these to
// persist only non-default overrides). Kept here, next to `state`, so the two can't drift.
export const CTRL_DEFAULTS = {p50:true,p95:false,p99:true,qps:true,scale:'linear',xmode:'elapsed',plot:'avg',armMode:'both'};

function isoRun(){ return PIN || HOVER; }
// Reflect the isolated run onto the DOM: bold its lines across all charts, dim the rest, and
// repaint the cursor. Called on hover/pin change and after each redraw (which rebuilds lines).
function applyIso(){
  var r = isoRun(), key = r ? (r.arm + '#' + r.idx) : null;
  var ps = document.querySelectorAll('.rln');
  for (var i=0;i<ps.length;i++) ps[i].classList.toggle('hon', !!key && ps[i].getAttribute('data-run')===key);
  document.body.classList.toggle('runhi', !!key);
  if (ACTIVE) ACTIVE.redrawCursor();
}

(function installRunHover(){
  document.addEventListener('mouseover', function(e:any){
    var h = e.target && e.target.closest && e.target.closest('[data-run]'); if(!h) return;
    var p = h.getAttribute('data-run').split('#');
    HOVER = { arm: p[0], idx: +p[1] }; applyIso();   // PIN, if set, still wins in isoRun()
  });
  document.addEventListener('mouseout', function(e:any){
    var h = e.target && e.target.closest && e.target.closest('[data-run]'); if(!h) return;
    var to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('[data-run]') : null;
    if (to && to.getAttribute('data-run')===h.getAttribute('data-run')) return; // still the same run
    HOVER = null; applyIso();
  });
  // Escape resets the zoom window (the on-plot double-click now toggles arms instead), matching
  // the control-bar reset button. Bound once here; routed to the current render via ACTIVE.
  document.addEventListener('keydown', function(e:any){
    if (e.key === 'Escape' && ACTIVE) ACTIVE.resetZoom();
  });
})();

export function runChart(RC){
 // Abort the previous render's document listeners before wiring this render's (see RENDER_AC).
 if(RENDER_AC) RENDER_AC.abort();
 var AC = new AbortController();
 RENDER_AC = AC;
(function(){
 var D=RC.chartData;
 var LAB=RC.labels||{ctl:'A',exp:'B'};
 var VAR={ctl_p50:'--ctl-p50',ctl_p95:'--ctl-p95',ctl_p99:'--ctl-p99',
          exp_p50:'--lh-p50',exp_p95:'--lh-p95',exp_p99:'--lh-p99'};
 var ARMS=['ctl','exp'];
 var PMETS=['p50','p95','p99'];
 var XMAX=RC.xmaxEl||1;
 // Fixed elapsed upper bound for both the latency and progress charts: the max sampled
 // elapsed across all runs/arms (i.e. the last post-completion steady-state reading).
 // It's global, so switching arms never rescales the axis — a faster arm's curve just
 // ends earlier within the fixed width — and it includes the whole post-100% tail
 // rather than clipping it at an estimated "completion + 1min".
 var XFULL=XMAX;
 var CTX=RC.ctx||{};
 // Mean download-completion elapsed for an arm: the mean of the runs' OWN 100% crossings
 // (CTX.timing[arm][100].mean) — the typical completion. NOT where the averaged
 // %-over-time curve reaches 100: that only happens once the slowest run finishes, so it
 // reads as the max. Used for the elapsed-mode completion markers; %-downloaded mode
 // already averages elapsed-at-100% (which equals this mean).
 function meanComplete(a){ var t=CTX.timing&&CTX.timing[a];
   return (t&&t[100]&&t[100].mean!=null)?t[100].mean:null; }
 // Graduated "band" shells shared by every plot's band (latency σ-band, its download
 // overlay, and the standalone download plot): [fraction, opacity] pairs. Each is a
 // nested fill at that fraction of the spread (±σ for latency, of the min/max envelope
 // for download); overlapping toward the mean makes the center densest and the edge
 // fade out by the full spread. The innermost shell is a touch more opaque so the core
 // (near the mean) reads a little stronger. Same set on every band so they look alike.
 var SHELLS=[[1,0.05],[0.75,0.05],[0.5,0.05],[0.25,0.08]];
 // range: elapsed-seconds window [start,end]; generalizes the old start-clip.
 // Persisted controls come from CTRL_DEFAULTS (module scope, shared with the slug logic);
 // the rest (remote-skew toggles, zoom range) aren't persisted and stay local.
 var state=Object.assign({}, CTRL_DEFAULTS, {
            rmin:true,rmean:false,rmax:true,rratio:false,rdelta:true,   // node-download-skew series toggles (ratio/delta mutually exclusive)
            range:{start:0,end:XMAX}}) as any;   // armMode ('both'|'A'|'B') comes from CTRL_DEFAULTS
 // Seed the sticky controls from a persisted slug (RC.ctrl0 holds only non-default
 // overrides). Re-applied on every runChart run so control state survives arm re-renders.
 if(RC.ctrl0) for(var _ck in RC.ctrl0){ if(_ck in state) state[_ck]=RC.ctrl0[_ck]; }
 // Called by the control handlers to push the current sticky state up to the slug.
 function persistCtrl(){ if(RC.persistCtrl) RC.persistCtrl(state); }
 function armOn(a){return a==='ctl' ? state.armMode!=='B' : state.armMode!=='A';}
 // Effective run index for arm `a`'s cursor readout: a hovered/pinned run isolates its own
 // arm (label that run; 'skip' suppresses the other arm's dot), else null (=> the mean line).
 // The cursor at()/head() closures consult this so hovering a run line relabels the cursor to
 // that run without re-rendering the plotted lines.
 function effRun(a){ var r=isoRun(); if(r) return r.arm===a ? r.idx : 'skip'; return null; }
 // Shared synced-cursor registry: op -> {x0,x1,xmin,xmax,yt,yb, gridX, head(cxv),
 // series:[{at(cxv)->value, y(value)->px, color, fmt(value)->str}]}. Every chart
 // (latency ops + the "__dl__" download chart) registers its geometry and the series
 // to annotate; one drawCursor(xv) then draws the vertical + dots/labels on all of
 // them. Rebuilt each redraw() (closures capture that render's scales + live state).
 var CURSORS={};
 function isFull(){return state.range.start<=0 && state.range.end>=XMAX;}
 function fnum(v){
   if(v>=1000)return Math.round(v).toLocaleString();
   if(v>=100)return String(Math.round(v));
   if(v>=10)return String(Math.round(v));
   return String(Math.round(v*10)/10);
 }
 function rms(v){return Math.round(v).toLocaleString();}   // whole-ms cursor readout
 // niceStep is imported (== core _nice_step); niceStep30 below is the cadence-snapped variant.
 // Samples are taken every 30s, so the elapsed x-axis only has readings at multiples
 // of 30. CAD is that cadence; time ticks and zoom bounds snap to it so labels land
 // on real data points (never a 100s tick when the nearest readings are 90/120s).
 var CAD=30;
 function niceStep30(range){var target=range/5,mults=[1,2,3,4,5,6,8,10,15,20,30,40,60,120,240,480];
   for(var i=0;i<mults.length;i++)if(CAD*mults[i]>=target)return CAD*mults[i];
   return CAD*mults[mults.length-1];}
 function interp(pts,xq){ // pts: [{x,m}]
   if(!pts.length||xq<pts[0].x||xq>pts[pts.length-1].x)return null;
   for(var i=1;i<pts.length;i++){if(pts[i].x>=xq){
     var a=pts[i-1],b=pts[i];if(b.x===a.x)return b.m;
     return a.m+(b.m-a.m)*(xq-a.x)/(b.x-a.x);}}
   return pts[pts.length-1].m;
 }
 // Linearly interpolate every numeric field of two points at x (non-numeric fields
 // taken from a); used to synthesize exact polyline endpoints at a zoom edge.
 function lerpPt(a,b,x){var t=(b.x===a.x)?0:(x-a.x)/(b.x-a.x),o={x:x};
   for(var k in a){if(k==='x')continue;
     o[k]=(typeof a[k]==='number'&&typeof b[k]==='number')?a[k]+(b[k]-a[k])*t:a[k];}
   return o;}
 // Clip a sorted [{x,...}] polyline to [lo,hi] by clipping each segment, so a zoomed
 // line meets the axis edges (interpolated endpoints) instead of stopping at the
 // first/last in-window sample and leaving a gap.
 function clipPts(pts,lo,hi){if(!pts||!pts.length)return [];
   if(pts.length===1){var q=pts[0];return (q.x>=lo&&q.x<=hi)?[q]:[];}
   var out=[],add=function(p){if(!out.length||out[out.length-1].x<p.x-1e-9)out.push(p);};
   for(var i=0;i<pts.length-1;i++){var a=pts[i],b=pts[i+1];
     if(b.x<lo||a.x>hi)continue;
     var xa=Math.max(lo,a.x),xb=Math.min(hi,b.x);
     add(xa===a.x?a:lerpPt(a,b,xa));
     add(xb===b.x?b:lerpPt(a,b,xb));}
   return out;}
 function build(op){
   var meta=D[op];
   var elapsed=state.xmode==='elapsed';
   var S=elapsed?meta.el:meta.pc;
   // Elapsed-seconds window. In elapsed mode this is the x-domain; in % mode it
   // is a time filter on the plotted points (x stays 0..100). y-scale is always
   // computed from the in-window data so a zoomed view rescales.
   var rstart=state.range.start||0;
   var rend=(state.range.end!=null?state.range.end:XMAX);
   var full=(rstart<=0 && rend>=XMAX);
   if(elapsed) rend=Math.min(rend, XFULL);   // fixed max(a+1min,b+1min); no arm-switch rescale
   // elapsed: clip each series to the range window, interpolating exact endpoints so
   // lines reach the zoom edges. % mode: filter by each point's elapsed (.e) instead.
   var FS={};
   if(elapsed){ for(var fk in S) FS[fk]=clipPts(S[fk]||[], rstart, rend); }
   else { for(var fk2 in S) FS[fk2]=(S[fk2]||[]).filter(function(p){return p.e==null?full:(p.e>=rstart&&p.e<=rend);}); }
   var W=760,H=320;                          // all charts share one size
   var x0=52,x1=690,yt=22,yb=284,lx=9;
   // With both arms shown, the download overlay (right axis + curve + milestones)
   // is ambiguous per-arm and lives instead in the dedicated A/B download chart in
   // the Duration section — so drop it from the latency plots and reclaim the width.
   var multiArm = RC.dual && armOn('ctl') && armOn('exp');
   // Reserve the right axis for: the download context (single-arm), or the qps overlay
   // in A/B (where there's no download axis and qps gets a labeled scale). Single-arm
   // qps rides the same reserved gutter with no ticks, so no extra width is needed.
   if(!multiArm || state.qps) x1-=40;
   var log=state.scale==='log';
   var keys=[];PMETS.forEach(function(m){if(state[m]){ARMS.forEach(function(a){
     if(armOn(a)&&FS[a+'_'+m]&&FS[a+'_'+m].length)keys.push(a+'_'+m);});}});
   var hi=[],lo=[];
   keys.forEach(function(k){(FS[k]||[]).forEach(function(p){hi.push(p.m+p.s);lo.push(p.m-p.s);});});
   var ymax=hi.length?Math.max.apply(null,hi):1,ymin,step;
   if(log){var pos=lo.filter(function(v){return v>0;});
     ymin=Math.max(1,(pos.length?Math.min.apply(null,pos):1)*0.85);ymax=ymax*1.15;}
   else{ymin=0;step=niceStep((ymax*1.02)/5);ymax=Math.ceil((ymax*1.02)/step)*step;if(!(ymax>0))ymax=1;}
   // x domain: elapsed shares a GLOBAL max so all charts align (synced cursor),
   // clipped to the range window; % is always 0..100.
   var xmin=elapsed?rstart:0;
   var xmax=elapsed?rend:100;
   if(!(xmax>xmin))xmax=xmin+1;
   function X(v){return x0+((v-xmin)/(xmax-xmin))*(x1-x0);}
   function Y(v){
     if(log){v=Math.max(v,ymin);
       return yb-((Math.log10(v)-Math.log10(ymin))/(Math.log10(ymax)-Math.log10(ymin)))*(yb-yt);}
     return yb-((v-ymin)/(ymax-ymin))*(yb-yt);
   }
   function Y2(pct){return yb-(pct/100)*(yb-yt);}  // right axis, 0..100%
   var s=[], hits=[];   // hits: fat transparent run hit-paths, appended last (topmost)
   s.push('<svg viewBox="0 0 '+W+' '+H+'" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="latency for '+op+'">');
   var ticks=[];
   if(log){var pp=Math.floor(Math.log10(ymin));while(true){var b=Math.pow(10,pp);
     [1,2,5].forEach(function(mn){var v=mn*b;if(v>=ymin*0.999&&v<=ymax*1.001)ticks.push(v);});
     if(b>ymax)break;pp++;}}
   else{for(var v=0;v<=ymax+1e-9;v+=step)ticks.push(v);}
   ticks.forEach(function(tv){var y=Y(tv);
     s.push('<line class="grid" x1="'+x0+'" y1="'+y.toFixed(1)+'" x2="'+x1+'" y2="'+y.toFixed(1)+'"/>');
     s.push('<text class="ytick" x="'+(x0-5)+'" y="'+(y+2).toFixed(1)+'" text-anchor="end">'+fnum(tv)+'ms</text>');});
   s.push('<line class="axis" x1="'+x0+'" y1="'+yt+'" x2="'+x0+'" y2="'+yb+'"/>');
   s.push('<line class="axis" x1="'+x0+'" y1="'+yb+'" x2="'+x1+'" y2="'+yb+'"/>');
   // x ticks. When zoomed, label the exact window edges (xmin/xmax) too, dropping
   // nice-step ticks that would crowd them — the first/last tick should be the edge.
   if(elapsed){var es=niceStep30(xmax-xmin);
     var xtick=function(v){var x=X(v);
       s.push('<line class="grid" x1="'+x.toFixed(1)+'" y1="'+yt+'" x2="'+x.toFixed(1)+'" y2="'+yb+'" opacity="0.5"/>');
       s.push('<text class="xtick" x="'+x.toFixed(1)+'" y="'+(yb+9)+'" text-anchor="middle">'+Math.round(v)+'s</text>');};
     for(var ev=Math.ceil(xmin/es)*es;ev<=xmax+1e-9;ev+=es){
       if(!full&&(Math.abs(ev-xmin)<es*0.5||Math.abs(ev-xmax)<es*0.5))continue;
       xtick(ev);}
     if(!full){xtick(xmin);xtick(xmax);}}
   else{[0,20,40,60,80,100].forEach(function(pc){var x=X(pc);
     s.push('<line class="grid" x1="'+x.toFixed(1)+'" y1="'+yt+'" x2="'+x.toFixed(1)+'" y2="'+yb+'" opacity="0.5"/>');
     s.push('<text class="xtick" x="'+x.toFixed(1)+'" y="'+(yb+9)+'" text-anchor="middle">'+pc+'%</text>');});}
   s.push('<text class="axtitle" x="'+((x0+x1)/2)+'" y="'+(H-4)+'" text-anchor="middle">'+(elapsed?'elapsed (s)':'% downloaded')+'</text>');
   s.push('<text class="axtitle" transform="rotate(-90 '+lx+' '+((yt+yb)/2)+')" x="'+lx+'" y="'+((yt+yb)/2)+'" text-anchor="middle">latency'+(log?' (log)':'')+'</text>');
   // Second (right) y-axis + download milestones — the download context overlaid on
   // the latency plot. Only shown when a single arm is in view; in A/B-both mode
   // the (per-arm-ambiguous) download context lives in the dedicated chart instead.
   if(!multiArm){
   // elapsed mode -> % undownloaded (download progress), Y2 in [0,100];
   // % mode       -> elapsed at each % (rises from 0 as runs progress), Y2s in [0,XMAX].
   var t2x=x1+32;
   var curve=function(c,yfn,cls,color){var d=c.map(function(p,i){return (i?'L':'M')+X(p.x).toFixed(1)+' '+yfn(p).toFixed(1);}).join(' ');s.push('<path class="'+(cls||'dlcurve')+'"'+(color?' style="stroke:'+color+'"':'')+' d="'+d+'"/>');};
   var runCurves=function(arr,yfn,color){(arr||[]).forEach(function(pl){var c2=clipPts(pl,xmin,xmax);if(c2.length>=2)curve(c2,yfn,'dlcurve dlrun',color);});};
   // Graduated shells (SHELLS) toward the mean, matching the latency and standalone
   // download bands. Y is linear so we interpolate each shell edge in y-space between
   // the mean (yfn) and the min/max edges (loFn/hiFn).
   var band=function(c,yfn,loFn,hiFn,color){SHELLS.forEach(function(sh){var f=sh[0],op=sh[1];
     var top=c.map(function(p){var m=yfn(p);return [X(p.x),m+f*(hiFn(p)-m)];});
     var bot=c.map(function(p){var m=yfn(p);return [X(p.x),m+f*(loFn(p)-m)];});
     var poly=top.concat(bot.reverse()).map(function(q){return q[0].toFixed(1)+','+q[1].toFixed(1);}).join(' ');
     s.push('<polygon points="'+poly+'" class="dlband" style="'+(color?'fill:'+color+';':'')+'opacity:'+op+'"/>');});};
   function y2axis(ticks,fmt,title){ticks.forEach(function(tv){var y=tv[1];
       s.push('<text class="y2tick" x="'+(x1+4)+'" y="'+(y+2).toFixed(1)+'" text-anchor="start">'+fmt(tv[0])+'</text>');});
     s.push('<text class="axtitle" transform="rotate(-90 '+t2x+' '+((yt+yb)/2)+')" x="'+t2x+'" y="'+((yt+yb)/2)+'" text-anchor="middle">'+title+'</text>');}
   function drawSecond(arms2, mean, runsArr, yfn, loFn, hiFn){
     arms2.forEach(function(a){if(!armOn(a))return;var c=clipPts(mean[a]||[],xmin,xmax);if(c.length<2)return;
       if(state.plot==='avg'){ (band as any)(c, yfn, loFn, hiFn); }
       else if(state.plot==='all'){ (runCurves as any)(runsArr[a], yfn); }
       (curve as any)(c, yfn);
     });
   }
   if(elapsed){
     var cl=function(u){return u<0?0:u>100?100:u;};
     y2axis([[0,Y2(0)],[25,Y2(25)],[50,Y2(50)],[75,Y2(75)],[100,Y2(100)]],function(v){return v+'%';},'% undownloaded');
     drawSecond(ARMS, meta.dl, meta.dlRuns,
       function(p){return Y2(cl(100-p.y));}, function(p){return Y2(cl(100-p.lo));}, function(p){return Y2(cl(100-p.hi));});
   } else {
     var smax=XMAX>0?XMAX:1; var Y2s=function(sec){return yb-(sec/smax)*(yb-yt);};
     var st2=niceStep(smax/4),tk=[]; for(var sv=0;sv<=smax+1e-9;sv+=st2)tk.push([sv,Y2s(sv)]);
     y2axis(tk,function(v){return Math.round(v)+'s';},'elapsed (s)');
     drawSecond(ARMS, meta.ep, meta.epRuns,
       function(p){return Y2s(p.y);}, function(p){return Y2s(p.lo);}, function(p){return Y2s(p.hi);});
   }
   // Vertical download-complete (100%) marker: the mean of the runs' completions
   // (meanComplete) — NOT where the averaged download curve reaches 100%, which lags to the
   // slowest run. Grey = the download dimension (not a latency arm).
   var dlOf=function(a){ return meta.dl[a]; };
   var completeEl=function(a){ return meanComplete(a); };
   if(elapsed){
     ARMS.forEach(function(a){if(!armOn(a))return;var dc=dlOf(a);if(!dc||!dc.length)return;
       var el=completeEl(a);if(el==null||el<xmin||el>xmax)return;var x=X(el);
       s.push('<line class="msline" x1="'+x.toFixed(1)+'" y1="'+yt+'" x2="'+x.toFixed(1)+'" y2="'+yb+'"/>');
       s.push('<text class="pctlab" x="'+x.toFixed(1)+'" y="'+(yt+7)+'" text-anchor="middle">100%</text>');
       s.push('<text class="mslab" x="'+x.toFixed(1)+'" y="'+(yb+16)+'" text-anchor="middle">'+Math.round(el)+'s</text>');});
   }else{
     var x=X(100),i=0;
     s.push('<line class="msline" x1="'+x.toFixed(1)+'" y1="'+yt+'" x2="'+x.toFixed(1)+'" y2="'+yb+'"/>');
     s.push('<text class="pctlab" x="'+x.toFixed(1)+'" y="'+(yt+7)+'" text-anchor="middle">100%</text>');
     ARMS.forEach(function(a){if(!armOn(a))return;var el=completeEl(a);if(el==null)return;
       s.push('<text class="mslab" x="'+x.toFixed(1)+'" y="'+(yb+16+i*7)+'" text-anchor="middle">'+Math.round(el)+'s</text>');i++;});
   }
   } else if(elapsed && state.plot==='avg'){
     // A vs B, avg view: no per-arm download overlay (ambiguous), but mark each arm's
     // mean completion (mean of its runs' 100% crossings) with a dimmed dashed vertical
     // in its color, with the elapsed-to-complete below the x-axis (the second arm's
     // seconds staggers down so the two don't collide). No "100%" label — the right axis
     // here is % *un*downloaded, so the line is at 0% there; the seconds carry the meaning.
     var mi=0;
     ARMS.forEach(function(a){ if(!armOn(a))return; var ce=meanComplete(a); if(ce==null||ce<xmin||ce>xmax)return;
       var x=X(ce), col=a==='ctl'?'var(--ctl-p95)':'var(--lh-p95)';
       s.push('<line x1="'+x.toFixed(1)+'" y1="'+yt+'" x2="'+x.toFixed(1)+'" y2="'+yb+'" style="stroke:'+col+';opacity:0.4;stroke-dasharray:4 3"/>');
       s.push('<text class="mslab" x="'+x.toFixed(1)+'" y="'+(yb+16+mi*7)+'" text-anchor="middle" style="fill:'+col+'">'+Math.round(ce)+'s</text>');
       mi++;});
   }
   // Spread layer behind the mean lines, per the plot dropdown:
   //  summary (avg) -> graduated ±σ band (nested 1σ/0.66σ/0.33σ shells, fading out);
   //  all           -> faint per-run polylines (ensemble; most honest, shows outliers).
   var runsMap = elapsed ? meta.elRuns : meta.pcRuns;
   {
     // Graduated ±σ band (SHELLS): nested translucent fills overlapping toward the mean
     // so the center reads densest and the edge fades out by ~1σ — a spread cue that
     // (unlike a min/max envelope) can't imply latency reached 0. Shown in BOTH summary
     // and all-runs modes (the spread is useful context either way).
     keys.forEach(function(k){var pts=FS[k]||[];if(pts.length<2)return;
       SHELLS.forEach(function(sh){var kk=sh[0],op=sh[1];
         var top=[],bot=[];
         pts.forEach(function(p){top.push([X(p.x),Y(p.m+kk*p.s)]);bot.push([X(p.x),Y(Math.max(p.m-kk*p.s,ymin))]);});
         var poly=top.concat(bot.reverse()).map(function(a){return a[0].toFixed(1)+','+a[1].toFixed(1);}).join(' ');
         s.push('<polygon points="'+poly+'" style="fill:var('+VAR[k]+');opacity:'+op+'"/>');});});
     if(state.plot==='all'){
       // All-runs: the individual run lines ARE the point, so draw them and skip the mean
       // line (the shells already convey the aggregate).
       keys.forEach(function(k){var rs=(runsMap&&runsMap[k])||[], arm=k.slice(0,3);
         rs.forEach(function(pl,ri){var c=clipPts(pl, xmin, xmax);if(c.length<2)return;
           var d=c.map(function(p,i){return (i?'L':'M')+X(p.x).toFixed(1)+' '+Y(p.y).toFixed(1);}).join(' ');
           var key=arm+'#'+ri;   // arm + run index: same run tagged the same across all charts
           s.push('<path class="rln" data-run="'+key+'" style="stroke:var('+VAR[k]+')" d="'+d+'"/>');
           hits.push('<path class="rlnhit" data-run="'+key+'" d="'+d+'"/>');});});
     } else {
       keys.forEach(function(k){var pts=FS[k]||[];if(pts.length<2)return;   // summary: mean line
         var d=pts.map(function(p,i){return (i?'L':'M')+X(p.x).toFixed(1)+' '+Y(p.m).toFixed(1);}).join(' ');
         s.push('<path class="ln" style="stroke:var('+VAR[k]+')" d="'+d+'"/>');});
     }
   }
   // QPS overlay (toggle): a dashed line per arm in its color, on its own scale (not
   // ms). In A/B the right axis is free, so qps gets labeled ticks there; single-arm's
   // right axis is the download context, so qps rides an unlabeled scale — just the
   // dashed line, tagged with a "qps" end-label so it's identifiable.
   if(state.qps){
     var qMean=function(a){ return elapsed ? meta.qpEl[a] : meta.qpPc[a]; };
     var qRuns=function(a){ return elapsed ? meta.qpElRuns[a] : meta.qpPcRuns[a]; };
     var qPick=function(a){ return qMean(a); };
     var qval=function(p){ return p.m!=null?p.m:p.y; };   // mean series has .m, per-run has .y
     var qmax=0;
     ARMS.forEach(function(a){ if(!armOn(a))return; (qPick(a)||[]).forEach(function(p){var v=qval(p); if(v>qmax)qmax=v;}); });
     if(qmax>0){
       var qstep=niceStep(qmax/4), qtop=Math.ceil(qmax/qstep)*qstep||1;
       var Yq=function(v){ return yb-(v/qtop)*(yb-yt); };
       if(multiArm){   // labeled right axis (no download axis in A/B)
         for(var qv=0;qv<=qtop+1e-9;qv+=qstep)
           s.push('<text class="y2tick" x="'+(x1+4)+'" y="'+(Yq(qv)+2).toFixed(1)+'" text-anchor="start">'+Math.round(qv)+'</text>');
         var qtx=x1+32;
         s.push('<text class="axtitle" transform="rotate(-90 '+qtx+' '+((yt+yb)/2)+')" x="'+qtx+'" y="'+((yt+yb)/2)+'" text-anchor="middle">qps</text>');
       }
       ARMS.forEach(function(a){ if(!armOn(a))return; var col=a==='ctl'?'var(--ctl-p95)':'var(--lh-p95)';
         var drawq=function(arr,key){ if(!arr||!arr.length)return null;
           var c=clipPts(arr.map(function(p){return {x:p.x,y:qval(p)};}), xmin, xmax); if(c.length<2)return null;
           var d=c.map(function(p,i){return (i?'L':'M')+X(p.x).toFixed(1)+' '+Yq(p.y).toFixed(1);}).join(' ');
           s.push('<path class="qpsln'+(key!=null?' rln':'')+'"'+(key!=null?' data-run="'+key+'"':'')+' style="stroke:'+col+'" d="'+d+'"/>');
           if(key!=null) hits.push('<path class="rlnhit" data-run="'+key+'" d="'+d+'"/>');
           return c; };
         if(state.plot==='all'){   // per-run qps lines (no mean line), tagged for run-hover
           (qRuns(a)||[]).forEach(function(pl,ri){ drawq(pl, a+'#'+ri); });
         } else {
           var c=drawq(qPick(a), null);
           if(c){ var lp=c[c.length-1], ly=Math.min(Math.max(Yq(lp.y),yt+6),yb-4);
             s.push('<text class="endlab" x="'+(X(lp.x)-2).toFixed(1)+'" y="'+(ly-2).toFixed(1)+'" text-anchor="end" style="fill:'+col+'">qps</text>'); }
         }
       });
     }
   }
   // Register this chart with the shared cursor: latency metrics on the ms scale (+ qps
   // on its own scale when on). The download context stays in the head text.
   (function(){
     var cser=[];
     PMETS.forEach(function(m){ if(!state[m])return; ARMS.forEach(function(a){ if(!armOn(a))return;
       var key=a+'_'+m;
       cser.push({color:'var('+VAR[key]+')', y:Y, fmt:rms, at:function(cxv){
         var e=effRun(a); if(e==='skip')return null;
         if(e!=null){var arr=runsMap&&runsMap[key];var pl=arr&&arr[e];return pl?interp2(pl,cxv):null;}
         var pts=S[key];return (pts&&pts.length)?interp(pts,cxv):null;}});
     });});
     if(state.qps && qtop>0 && typeof Yq==='function'){
       ARMS.forEach(function(a){ if(!armOn(a))return;
         var qm=elapsed?meta.qpEl:meta.qpPc, qr=elapsed?meta.qpElRuns:meta.qpPcRuns;
         cser.push({color:'var('+(a==='ctl'?'--ctl-p95':'--lh-p95')+')', y:Yq, fmt:rms, at:function(cxv){
           var e=effRun(a); if(e==='skip')return null;
           if(e!=null){var arr=qr[a]&&qr[a][e];return arr?interp2(arr,cxv):null;}
           var pts=qm[a];return (pts&&pts.length)?interp(pts,cxv):null;}});
       });
     }
     var g0=null; for(var gk in S){ if(S[gk]&&S[gk].length){ g0=S[gk].map(function(p){return p.x;}); break; } }
     CURSORS[op]={x0:x0,x1:x1,xmin:xmin,xmax:xmax,yt:yt,yb:yb,W:W,gridX:g0,series:cser,
       head:function(cxv){ var h=elapsed?(Math.round(cxv)+'s'):(Math.round(cxv)+'%'); var _r=isoRun();
         if(_r)h+=' · '+((multiArm||RC.dual)?((LAB[_r.arm]||_r.arm)+' '):'')+'run '+(_r.idx+1);
         // Download context: normally single-arm only (ambiguous with both arms shown), but an
         // isolated run has picked one arm, so show that run's %-downloaded even in dual.
         if(elapsed&&(!multiArm||_r)){var pc=null;ARMS.forEach(function(a){if(!armOn(a))return;
           var e=effRun(a); if(e==='skip')return;
           var cc=e!=null?(meta.dlRuns[a]||[])[e]:meta.dl[a];
           if(cc&&pc==null){var p=interp2(cc,cxv);if(p!=null)pc=p;}}); if(pc!=null)h+=' · '+Math.round(pc)+'% dl';}
         return h; }};
   })();
   // p99 end-labels (arm names).
   if(state.p99){var ep:any={};ARMS.forEach(function(a){if(!armOn(a))return;var pts=FS[a+'_p99'];if(!pts||!pts.length)return;
     var p=pts[pts.length-1];ep[a]=[X(p.x),Math.min(Math.max(Y(p.m),yt+6),yb-4)];});
     if(ep.ctl&&ep.exp&&Math.abs(ep.ctl[1]-ep.exp[1])<10){
       var h=ep.ctl[1]<=ep.exp[1]?'ctl':'exp',l=h==='ctl'?'exp':'ctl';
       ep[l][1]=ep[h][1]+10;var ov=ep[l][1]-(yb-4);if(ov>0){ep[h][1]-=ov;ep[l][1]-=ov;}}
     ARMS.forEach(function(a){if(!ep[a])return;
       s.push('<text class="endlab" x="'+(ep[a][0]+4).toFixed(1)+'" y="'+(ep[a][1]+2).toFixed(1)+'" style="fill:var('+VAR[a+'_p99']+')">'+(LAB[a]||a)+' p99</text>');});}
   // Synced-cursor hit area + empty layer the mousemove handler fills (no rebuild).
   s.push('<rect class="scrubhit" x="0" y="0" width="'+W+'" height="'+H+'" fill="transparent" pointer-events="all" '+
     'data-op="'+op+'" data-x0="'+x0+'" data-x1="'+x1+'" data-xmin="'+xmin+'" data-xmax="'+xmax+'" data-yt="'+yt+'" data-yb="'+yb+'" '+
     'data-ymin="'+ymin+'" data-ymax="'+ymax+'" data-log="'+(log?1:0)+'" data-qtop="'+(qtop||0)+'"/>');
   s.push('<g class="cursorlayer" data-op="'+op+'"></g>');
   if(hits.length) s.push(hits.join(''));   // run hit-paths on top so hover reaches them
   s.push('</svg>');
   return s.join('');
 }
 // Standalone A/B download-progress plot for the "restore" section: % undownloaded
 // Download progress is cluster-wide, so any op's curves serve — read off the
 // aggregate. Obeys the same plot controls (summary/all/run) and arm cycle. Both
 // x-modes are oriented so runs START TOGETHER and END APART (they began at the same
 // instant and diverged as they ran), just transposed:
 //  elapsed -> y = % downloaded (0 -> 100, up-and-right), x = elapsed. All start at
 //             (0s, 0%), each reaches 100% at its own finish time (end apart on x).
 //  %-downloaded -> y = elapsed, x = % downloaded (0 -> 100). All start at (0%, 0s),
 //             each reaches 100% at its own finish time (end apart on y). Same data
 //             as the latency plots' second axis (ep). (Undownloaded-vs-%downloaded
 //             would just be a straight line, so %-mode plots elapsed-to-reach-%.)
 // In elapsed mode a drag zooms the shared range (like the latency plots); a plain
 // click cycles arms. 100%-completion diamonds mark finish times: per-run in "all"
 // mode (>1 run, showing the spread), and on each mean in avg mode when arms are being
 // compared (so you can see which arm finished first).
 function buildDownload(){
   var host=document.querySelector('.dlchart[data-dl]'); if(!host) return;
   var op=D.agg?'agg':Object.keys(D)[0]; var meta=op&&D[op];
   if(!meta||!meta.dl){ host.innerHTML=''; return; }
   var elapsed=state.xmode==='elapsed';
   var W=760,H=320,x0=52,x1=650,yt=22,yb=284,lx=9;   // same size as the other charts; x1 leaves the MB/s gutter
   var cl=function(u){return u<0?0:u>100?100:u;};
   var colOf={ctl:'var(--ctl-p95)',exp:'var(--lh-p95)'};
   // Comparing arms (more than one arm actually shown with data): keep a 100%-
   // completion diamond on each mean even in avg mode, so you can see which finished
   // first. Gated on data presence so a single-arm report doesn't count "exp" as on.
   var multi=ARMS.filter(function(a){return armOn(a) && meta.dl[a] && meta.dl[a].length;}).length>1;
   var crossEl=_dlCrossT;
   var diamond=function(cx,cy,color){var r=3.4;
     s.push('<polygon class="dldiam" points="'+cx.toFixed(1)+','+(cy-r).toFixed(1)+' '+(cx+r).toFixed(1)+','+cy.toFixed(1)
       +' '+cx.toFixed(1)+','+(cy+r).toFixed(1)+' '+(cx-r).toFixed(1)+','+cy.toFixed(1)+'" style="fill:'+color+'"/>');};
   var s=[], hits=[];   // hits: fat transparent run hit-paths, appended last (topmost)
   // preserveAspectRatio="none" lets the chart squish vertically when it's pinned compact
   // (CSS forces a short height then). At full height (height:auto) it has no visible effect.
   s.push('<svg viewBox="0 0 '+W+' '+H+'" width="100%" preserveAspectRatio="none" role="img" aria-label="download progress">');
   var xmin,xmax,X,Y,curve,band,drawArm,xTitle,yTitle,xticks;
   if(elapsed){
     var rstart=state.range.start||0, rend=(state.range.end!=null?state.range.end:XMAX);
     var full=(rstart<=0 && rend>=XMAX);
     // Fixed domain [0, max(a+1min,b+1min)] shared with the latency chart, so switching
     // arms doesn't rescale the axis. Curves still truncate at their own 100% (cut100
     // below), so a faster arm ends earlier within this fixed width.
     xmin=rstart; xmax=Math.min(rend, XFULL); if(!(xmax>xmin))xmax=xmin+1;
     // Truncate a download polyline at its first 100% (interpolated), dropping the flat
     // post-completion tail.
     var cut100=function(pl){ if(!pl||!pl.length)return pl;
       for(var i=0;i<pl.length;i++){ if(pl[i].y>=100){ if(i===0)return [pl[0]];
         var a=pl[i-1],b=pl[i],t=(b.y===a.y)?0:(100-a.y)/(b.y-a.y),e:any={};
         for(var k in a)e[k]=(typeof a[k]==='number'&&typeof b[k]==='number')?a[k]+(b[k]-a[k])*t:a[k];
         e.y=100; return pl.slice(0,i).concat([e]); } }
       return pl; };
     X=function(v){return x0+((v-xmin)/(xmax-xmin))*(x1-x0);};
     Y=function(v){return yb-(v/100)*(yb-yt);};          // 0..100, 0 at bottom
     var dY=function(p){return Y(cl(p.y));};             // % downloaded (rises up-and-right)
     yTitle='% downloaded'; xTitle='elapsed (s)';
     [0,25,50,75,100].forEach(function(u){var y=Y(u);
       s.push('<line class="grid" x1="'+x0+'" y1="'+y.toFixed(1)+'" x2="'+x1+'" y2="'+y.toFixed(1)+'"/>');
       s.push('<text class="ytick" x="'+(x0-5)+'" y="'+(y+2).toFixed(1)+'" text-anchor="end">'+u+'%</text>');});
     xticks=function(){var es=niceStep30(xmax-xmin);
       var xt=function(v){var x=X(v);
         s.push('<line class="grid" x1="'+x.toFixed(1)+'" y1="'+yt+'" x2="'+x.toFixed(1)+'" y2="'+yb+'" opacity="0.5"/>');
         s.push('<text class="xtick" x="'+x.toFixed(1)+'" y="'+(yb+9)+'" text-anchor="middle">'+Math.round(v)+'s</text>');};
       for(var ev=Math.ceil(xmin/es)*es;ev<=xmax+1e-9;ev+=es){
         if(!full&&(Math.abs(ev-xmin)<es*0.5||Math.abs(ev-xmax)<es*0.5))continue; xt(ev);}
       if(!full){xt(xmin);xt(xmax);}};
     curve=function(c,color,cls,key){var cc=clipPts(cut100(c),xmin,xmax);
       var d=cc.map(function(p,i){return (i?'L':'M')+X(p.x).toFixed(1)+' '+dY(p).toFixed(1);}).join(' ');
       if(cc.length<2)return; var run=(cls==='rln'&&key!=null)?' data-run="'+key+'"':'';
       s.push('<path class="'+(cls||'ln')+'"'+run+' style="stroke:'+color+'" d="'+d+'"/>');
       if(cls==='rln'&&key!=null) hits.push('<path class="rlnhit" data-run="'+key+'" d="'+d+'"/>');};
     band=function(c,color){var cc=clipPts(cut100(c),xmin,xmax); if(cc.length<2)return;
       SHELLS.forEach(function(sh){var f=sh[0],op=sh[1];
         var top=cc.map(function(p){return [X(p.x),Y(cl(p.y+f*(p.hi-p.y)))];});
         var bot=cc.map(function(p){return [X(p.x),Y(cl(p.y-f*(p.y-p.lo)))];});
         s.push('<polygon class="dlband" points="'+top.concat(bot.reverse()).map(function(q){return q[0].toFixed(1)+','+q[1].toFixed(1);}).join(' ')+'" style="fill:'+color+';opacity:'+op+'"/>');});};
     // 100% completion is at downloaded 100 (top axis), x = each run's finish time.
     var inWin=function(v){return v>=xmin-1e-9 && v<=xmax+1e-9;};
     drawArm=function(a){var runs=meta.dlRuns[a]||[], nr=runs.length, mean=meta.dl[a]||[];
       if(state.plot==='all'){ if(mean.length>=2)band(mean,colOf[a]);   // shells, no mean line
         runs.forEach(function(pl,ri){curve(pl,colOf[a],'rln',a+'#'+ri);
         if(nr>1){var rc=crossEl(pl,100); if(rc!=null&&inWin(rc)) diamond(X(rc),Y(100),colOf[a]);}}); }
       else { if(mean.length>=2){band(mean,colOf[a]);curve(mean,colOf[a]);
         var ce=meanComplete(a); if(ce!=null&&inWin(ce)){var xc=X(ce);
           // Mean completion (mean of the runs' 100% crossings): dimmed dashed vertical +
           // diamond at the 100% line + elapsed label. This sits left of where the
           // averaged curve visually reaches 100% (which lags to the slowest run); the
           // mean is the typical finish. Label staggers down for the 2nd arm (A vs B).
           s.push('<line x1="'+xc.toFixed(1)+'" y1="'+yt+'" x2="'+xc.toFixed(1)+'" y2="'+yb+'" style="stroke:'+colOf[a]+';opacity:0.4;stroke-dasharray:4 3"/>');
           diamond(xc,Y(100),colOf[a]);
           var yoff=(multi&&a==='exp')?23:16;
           s.push('<text class="mslab" x="'+xc.toFixed(1)+'" y="'+(yb+yoff)+'" text-anchor="middle" style="fill:'+colOf[a]+'">'+Math.round(ce)+'s</text>');
         }} }
       if(mean.length){var mc=crossEl(mean,100), lxp=(mc!=null?Math.min(mc,xmax):null);
         if(lxp!=null&&inWin(lxp)) s.push('<text class="endlab" x="'+(X(lxp)+4).toFixed(1)+'" y="'+(yt+8).toFixed(1)+'" style="fill:'+colOf[a]+'">'+(LAB[a]||a)+'</text>');}};
   } else {
     // %-mode: elapsed (y) vs % downloaded (x). y-scale from the shown runs' finishes.
     xmin=0; xmax=100;
     // y-scale fixed over BOTH arms (and >= XFULL) so switching arms doesn't rescale it.
     var ymax=XFULL; ARMS.forEach(function(a){(meta.ep[a]||[]).forEach(function(p){if(p.hi>ymax)ymax=p.hi;});});
     var yst=niceStep((ymax*1.02)/5); ymax=Math.ceil((ymax*1.02)/yst)*yst; if(!(ymax>0))ymax=1;
     X=function(v){return x0+(v/100)*(x1-x0);};
     Y=function(sec){return yb-(sec/ymax)*(yb-yt);};
     yTitle='elapsed (s)'; xTitle='% downloaded';
     for(var yv=0;yv<=ymax+1e-9;yv+=yst){var y=Y(yv);
       s.push('<line class="grid" x1="'+x0+'" y1="'+y.toFixed(1)+'" x2="'+x1+'" y2="'+y.toFixed(1)+'"/>');
       s.push('<text class="ytick" x="'+(x0-5)+'" y="'+(y+2).toFixed(1)+'" text-anchor="end">'+Math.round(yv)+'s</text>');}
     xticks=function(){[0,20,40,60,80,100].forEach(function(pc){var x=X(pc);
       s.push('<line class="grid" x1="'+x.toFixed(1)+'" y1="'+yt+'" x2="'+x.toFixed(1)+'" y2="'+yb+'" opacity="0.5"/>');
       s.push('<text class="xtick" x="'+x.toFixed(1)+'" y="'+(yb+9)+'" text-anchor="middle">'+pc+'%</text>');});};
     curve=function(c,color,cls,key){var d=c.map(function(p,i){return (i?'L':'M')+X(p.x).toFixed(1)+' '+Y(p.y).toFixed(1);}).join(' ');
       if(c.length<2)return; var run=(cls==='rln'&&key!=null)?' data-run="'+key+'"':'';
       s.push('<path class="'+(cls||'ln')+'"'+run+' style="stroke:'+color+'" d="'+d+'"/>');
       if(cls==='rln'&&key!=null) hits.push('<path class="rlnhit" data-run="'+key+'" d="'+d+'"/>');};
     band=function(c,color){SHELLS.forEach(function(sh){var f=sh[0],op=sh[1];
       var top=c.map(function(p){return [X(p.x),Y(p.y+f*(p.hi-p.y))];});
       var bot=c.map(function(p){return [X(p.x),Y(p.y-f*(p.y-p.lo))];});
       if(top.length<2)return;
       s.push('<polygon class="dlband" points="'+top.concat(bot.reverse()).map(function(q){return q[0].toFixed(1)+','+q[1].toFixed(1);}).join(' ')+'" style="fill:'+color+';opacity:'+op+'"/>');});};
     // 100% completion is at x=100 (right edge), y = each run's finish time.
     drawArm=function(a){var runs=meta.epRuns[a]||[], nr=runs.length, mean=meta.ep[a]||[];
       if(state.plot==='all'){ if(mean.length>=2)band(mean,colOf[a]);   // shells, no mean line
         runs.forEach(function(pl,ri){curve(pl,colOf[a],'rln',a+'#'+ri);
         if(nr>1){var lp=pl[pl.length-1]; if(lp) diamond(X(lp.x),Y(lp.y),colOf[a]);}}); }
       else { if(mean.length>=2){band(mean,colOf[a]);curve(mean,colOf[a]);
         if(multi){var mlp=mean[mean.length-1]; if(mlp) diamond(X(mlp.x),Y(mlp.y),colOf[a]);}} }
       if(mean.length){var lp=mean[mean.length-1]; var ly=Math.min(Math.max(Y(lp.y),yt+6),yb-4);
         s.push('<text class="endlab" x="'+(X(lp.x)-2).toFixed(1)+'" y="'+(ly-3).toFixed(1)+'" text-anchor="end" style="fill:'+colOf[a]+'">'+(LAB[a]||a)+'</text>');}};
   }
   s.push('<line class="axis" x1="'+x0+'" y1="'+yt+'" x2="'+x0+'" y2="'+yb+'"/>');
   s.push('<line class="axis" x1="'+x0+'" y1="'+yb+'" x2="'+x1+'" y2="'+yb+'"/>');
   xticks();
   s.push('<text class="axtitle" x="'+((x0+x1)/2)+'" y="'+(H-4)+'" text-anchor="middle">'+xTitle+'</text>');
   s.push('<text class="axtitle" transform="rotate(-90 '+lx+' '+((yt+yb)/2)+')" x="'+lx+'" y="'+((yt+yb)/2)+'" text-anchor="middle">'+yTitle+'</text>');
   ARMS.forEach(function(a){ if(armOn(a)) drawArm(a); });
   // MB/s overlay on the reserved right axis: dashed mean + σ-shell band per arm (same
   // shell treatment as the latency plots). The source series is already per-node (the
   // test divides the cluster-wide free-space delta by #nodes), so values are plotted as-is.
   // NODES is used solely to decide axis-label wording.
   var NODES=RC.nodes||1;
   var mbTitle=NODES>1?'MB/s/node':'MB/s';
   var mMean=function(a){return elapsed?meta.mb[a]:meta.mbPc[a];};
   var mRuns=function(a){return elapsed?meta.mbRuns[a]:meta.mbPcRuns[a];};
   var mPick=function(a){return mMean(a);};
   var mmax=0;
   ARMS.forEach(function(a){if(!armOn(a))return;(mPick(a)||[]).forEach(function(p){var v=(p.hi!=null?p.hi:(p.m!=null?p.m:p.y));if(v>mmax)mmax=v;});});
   var Ymb=null;
   if(mmax>0){
     var mstep=niceStep(mmax/4), mtop=Math.ceil(mmax/mstep)*mstep||1;
     Ymb=function(v){return yb-(v/mtop)*(yb-yt);};   // v is per-node MB/s
     for(var mv=0;mv<=mtop+1e-9;mv+=mstep)
       s.push('<text class="y2tick" x="'+(x1+4)+'" y="'+(Ymb(mv)+2).toFixed(1)+'" text-anchor="start">'+Math.round(mv)+'</text>');
     s.push('<text class="axtitle" transform="rotate(-90 '+(x1+30)+' '+((yt+yb)/2)+')" x="'+(x1+30)+'" y="'+((yt+yb)/2)+'" text-anchor="middle">'+mbTitle+'</text>');
     // Throughput uses the lighter (p50) arm shade so it reads distinctly from the
     // %-downloaded band/line (which uses the p95 shade), like p50 vs p99 on latency.
     ARMS.forEach(function(a){ if(!armOn(a))return; var col=(a==='ctl'?'var(--ctl-p50)':'var(--lh-p50)');
       var runLine=function(pl,key){ var cc=clipPts(pl,xmin,xmax); if(cc.length<2)return;
         var d=cc.map(function(p,i){return (i?'L':'M')+X(p.x).toFixed(1)+' '+Ymb(p.y).toFixed(1);}).join(' ');
         s.push('<path class="mbln'+(key!=null?' rln':'')+'"'+(key!=null?' data-run="'+key+'"':'')+' style="stroke:'+col+'" d="'+d+'"/>');
         if(key!=null) hits.push('<path class="rlnhit" data-run="'+key+'" d="'+d+'"/>'); };
       var band2=function(mean){ var cc=clipPts(mean,xmin,xmax); if(cc.length<2)return null;
         SHELLS.forEach(function(sh){var f=sh[0],op2=sh[1];
           var top=cc.map(function(p){return [X(p.x),Ymb(Math.max(0,p.m+f*p.s))];});
           var bot=cc.map(function(p){return [X(p.x),Ymb(Math.max(0,p.m-f*p.s))];});
           s.push('<polygon class="dlband" points="'+top.concat(bot.reverse()).map(function(q){return q[0].toFixed(1)+','+q[1].toFixed(1);}).join(' ')+'" style="fill:'+col+';opacity:'+op2+'"/>');});
         return cc; };
       if(state.plot==='all'){ var mn=mMean(a); if(mn&&mn.length>=2) band2(mn);   // shells, no mean line
         (mRuns(a)||[]).forEach(function(pl,ri){ runLine(pl, a+'#'+ri); }); }
       else { var mn=mMean(a); var cc=band2(mn); if(cc)
         s.push('<path class="mbln" style="stroke:'+col+'" d="'+cc.map(function(p,i){return (i?'L':'M')+X(p.x).toFixed(1)+' '+Ymb(p.m).toFixed(1);}).join(' ')+'"/>'); }
     });
   }
   // Register the download chart with the shared cursor: %downloaded (or elapsed-to-%
   // in %-mode) on the left scale + MB/s on the right scale. The head above the graph
   // reads "dur · %downloaded · MB/s".
   (function(){
     var cser=[];
     ARMS.forEach(function(a){ if(!armOn(a))return; var col=colOf[a];
       if(elapsed){ cser.push({color:col, y1:true, y:function(v){return Y(cl(v));}, fmt:function(v){return Math.round(v)+'%';},
         at:function(cxv){var e=effRun(a); if(e==='skip')return null; var c=e!=null?(meta.dlRuns[a]||[])[e]:meta.dl[a]; return c?interp2(c,cxv):null;}}); }
       else { cser.push({color:col, y1:true, y:function(v){return Y(v);}, fmt:function(v){return Math.round(v)+'s';},
         at:function(cxv){var e=effRun(a); if(e==='skip')return null; var c=e!=null?(meta.epRuns[a]||[])[e]:meta.ep[a]; return c?interp2(c,cxv):null;}}); }
     });
     if(Ymb){ ARMS.forEach(function(a){ if(!armOn(a))return; var col=colOf[a];
       cser.push({color:col, y:function(v){return Ymb(v);}, fmt:function(v){return Math.round(v)+' MB/s';}, at:function(cxv){
         var e=effRun(a); if(e==='skip')return null;
         if(e!=null){var pl=(mRuns(a)||[])[e];return pl?interp2(pl,cxv):null;}
         var mn=mMean(a);return (mn&&mn.length)?interp(mn,cxv):null;}});
     }); }
     var mAt=function(cxv){var v=null;ARMS.forEach(function(a){if(!armOn(a)||v!=null)return;
       var mn=mMean(a);
       if(mn&&mn.length){var q=interp(mn,cxv);if(q!=null)v=q;}});return v;};
     var pcAt=function(cxv){var v=null;ARMS.forEach(function(a){if(!armOn(a)||v!=null)return;
       var c=meta.dl[a];if(c){var q=interp2(c,cxv);if(q!=null)v=q;}});return v;};
     var d0=elapsed?meta.dl[armOn('ctl')?'ctl':'exp']:meta.ep[armOn('ctl')?'ctl':'exp'];
     var g0=(d0&&d0.length)?d0.map(function(p){return p.x;}):null;
     CURSORS['__dl__']={x0:x0,x1:x1,xmin:xmin,xmax:xmax,yt:yt,yb:yb,W:W,gridX:g0,series:cser,
       head:function(cxv){
         // With both arms shown, %downloaded and MB/s differ per arm; pcAt/mAt would
         // silently report only arm A's, reading as "arm A" in the head. The per-arm
         // cursor dots already carry each arm's value, so drop the arm-specific readout
         // here and show just the x position — mirroring the latency head, which likewise
         // omits its "% dl" annotation in multi-arm mode.
         var _r=isoRun();
         if(_r){ var ha=_r.arm, hi=_r.idx;
           var dc=elapsed?(meta.dlRuns[ha]||[])[hi]:(meta.epRuns[ha]||[])[hi];
           var mc=(mRuns(ha)||[])[hi];
           var hh=(elapsed?(Math.round(cxv)+'s'):(Math.round(cxv)+'%'))
                + ' · '+(RC.dual?((LAB[ha]||ha)+' '):'')+'run '+(hi+1);
           var pcv=dc?interp2(dc,cxv):null; if(elapsed&&pcv!=null)hh+=' · '+Math.round(pcv)+'%';
           var mv2=mc?interp2(mc,cxv):null; if(mv2!=null)hh+=' · '+Math.round(mv2)+' MB/s';
           return hh; }
         if(multi) return elapsed?(Math.round(cxv)+'s'):(Math.round(cxv)+'%');
         var pc=pcAt(cxv), mv=mAt(cxv);
         var h=elapsed?(Math.round(cxv)+'s'):(Math.round(pc!=null?pc:cxv)+'%');
         if(elapsed&&pc!=null)h+=' · '+Math.round(pc)+'%';
         if(mv!=null)h+=' · '+Math.round(mv)+' MB/s';
         return h; }};
   })();
   // Drag-to-zoom / click-to-cycle hit area; the shared cursor draws into the layer.
   s.push('<rect class="scrubhit" x="0" y="0" width="'+W+'" height="'+H+'" fill="transparent" pointer-events="all" '+
     'data-op="__dl__" data-x0="'+x0+'" data-x1="'+x1+'" data-xmin="'+xmin+'" data-xmax="'+xmax+'" data-yt="'+yt+'" data-yb="'+yb+'"/>');
   s.push('<g class="cursorlayer" data-op="__dl__"></g>');
   if(hits.length) s.push(hits.join(''));   // run hit-paths on top so hover reaches them
   s.push('</svg>');
   host.innerHTML=s.join('');
 }
 // Per-node remote-bytes skew chart. y1 = absolute MB remaining reduced across nodes to
 // min/mean/max (faint min/max envelope + fill, bold mean); y2 = the dimensionless
 // long-pole ratio (max-mean)/mean. Mirrors buildDownload's axis/view-mode machinery.
 // Degrades to a note when node_remote_mb wasn't in the payload (older links).
 function buildRemote(){
   var host=document.querySelector('.chart[data-remote]'); if(!host) return;
   var op=D.agg?'agg':Object.keys(D)[0]; var meta=op&&D[op];
   var have=meta&&meta.rMean&&ARMS.some(function(a){return (meta.rMean[a]||[]).length;});
   if(!have){ host.innerHTML='<p class="caveat">No per-node remote-bytes data in this payload — regenerate the report link to populate it.</p>'; return; }
   var elapsed=state.xmode==='elapsed';
   var W=760,H=320,x0=52,x1=650,yt=22,yb=284,lx=9;
   var s=[], hits=[];
   var pv=function(p){return p.m!=null?p.m:p.y;};
   var axn=function(v){return v>=100?Math.round(v):Math.round(v*10)/10;};
   // Distinct shades per level (like latency's p50/p95/p99) so min/mean/max read apart:
   // min -> p50 (light), mean -> p99 (dark/bold via .ln), max -> p95 (mid). Ratio -> p95.
   var shadeOf=function(a,sh){return 'var(--'+(a==='ctl'?'ctl':'lh')+'-'+sh+')';};
   var tintOf=function(a){return shadeOf(a,'p50');};    // per-run min->max fill tint
   var ratioCol=function(a){return shadeOf(a,'p95');};  // y2 overlay
   var LV=[['Min','p50'],['Mean','p99'],['Max','p95']];
   var lvOn=function(w){return !!state['r'+w.toLowerCase()];};
   s.push('<svg viewBox="0 0 '+W+' '+H+'" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="remote bytes remaining per node">');

   // --- x axis (shared with the other charts: elapsed honours the zoom range, pct is 0..100) ---
   var xmin,xmax,X,xTitle,xticks;
   if(elapsed){
     var rstart=state.range.start||0, rend=(state.range.end!=null?state.range.end:XMAX);
     var full=(rstart<=0 && rend>=XMAX);
     xmin=rstart; xmax=Math.min(rend, XFULL); if(!(xmax>xmin))xmax=xmin+1;
     X=function(v){return x0+((v-xmin)/(xmax-xmin))*(x1-x0);};
     xTitle='elapsed (s)';
     xticks=function(){var es=niceStep30(xmax-xmin);
       var xt=function(v){var x=X(v);
         s.push('<line class="grid" x1="'+x.toFixed(1)+'" y1="'+yt+'" x2="'+x.toFixed(1)+'" y2="'+yb+'" opacity="0.5"/>');
         s.push('<text class="xtick" x="'+x.toFixed(1)+'" y="'+(yb+9)+'" text-anchor="middle">'+Math.round(v)+'s</text>');};
       for(var ev=Math.ceil(xmin/es)*es;ev<=xmax+1e-9;ev+=es){
         if(!full&&(Math.abs(ev-xmin)<es*0.5||Math.abs(ev-xmax)<es*0.5))continue; xt(ev);}
       if(!full){xt(xmin);xt(xmax);}};
   } else {
     xmin=0; xmax=100;
     X=function(v){return x0+(v/100)*(x1-x0);};
     xTitle='% downloaded';
     xticks=function(){[0,20,40,60,80,100].forEach(function(pc){var x=X(pc);
       s.push('<line class="grid" x1="'+x.toFixed(1)+'" y1="'+yt+'" x2="'+x.toFixed(1)+'" y2="'+yb+'" opacity="0.5"/>');
       s.push('<text class="xtick" x="'+x.toFixed(1)+'" y="'+(yb+9)+'" text-anchor="middle">'+pc+'%</text>');});};
   }

   // --- series pickers: elapsed vs pct ---
   var mean=function(a,w){return elapsed?meta['r'+w][a]:meta['r'+w+'Pc'][a];};
   var runsOf=function(a,w){return elapsed?meta['r'+w+'Runs'][a]:meta['r'+w+'PcRuns'][a];};

   // --- y1 scale (absolute MB) from what is actually drawn: per-run points in all mode,
   // shell tops (m+σ) in summary ---
   var ymax=0, bump=function(v){if(v>ymax)ymax=v;};
   ARMS.forEach(function(a){ if(!armOn(a))return;
     LV.forEach(function(L){ if(!lvOn(L[0]))return; var w=L[0];
       if(state.plot==='all'){ (runsOf(a,w)||[]).forEach(function(pl){(pl||[]).forEach(function(p){bump(pv(p));});}); }
       else { (mean(a,w)||[]).forEach(function(p){bump((p.m!=null?p.m:0)+(p.s||0));}); }
     });
   });
   var unit='MB',div=1;
   if(ymax>=1048576){unit='TB';div=1048576;} else if(ymax>=1024){unit='GB';div=1024;}
   var yst=niceStep((ymax*1.02)/5); ymax=Math.ceil((ymax*1.02)/yst)*yst; if(!(ymax>0))ymax=1;
   var Y=function(v){return yb-(v/ymax)*(yb-yt);};
   for(var yv=0;yv<=ymax+1e-9;yv+=yst){var y=Y(yv);
     s.push('<line class="grid" x1="'+x0+'" y1="'+y.toFixed(1)+'" x2="'+x1+'" y2="'+y.toFixed(1)+'"/>');
     s.push('<text class="ytick" x="'+(x0-5)+'" y="'+(y+2).toFixed(1)+'" text-anchor="end">'+axn(yv/div)+'</text>');}

   // --- draw helpers ---
   var line=function(c,color,klass,key){var cc=clipPts(c,xmin,xmax); if(cc.length<2)return;
     var d=cc.map(function(p,i){return (i?'L':'M')+X(p.x).toFixed(1)+' '+Y(pv(p)).toFixed(1);}).join(' ');
     s.push('<path class="'+klass+'"'+(key!=null?' data-run="'+key+'"':'')+' style="stroke:'+color+'" d="'+d+'"/>');
     if(key!=null) hits.push('<path class="rlnhit" data-run="'+key+'" d="'+d+'"/>');};
   var shell=function(c,color){var cc=clipPts(c,xmin,xmax); if(cc.length<2)return;   // ±σ graduated band
     SHELLS.forEach(function(sh){var f=sh[0],opq=sh[1];
       var top=cc.map(function(p){return [X(p.x),Y(p.m+f*(p.s||0))];});
       var bot=cc.map(function(p){return [X(p.x),Y(Math.max(p.m-f*(p.s||0),0))];});
       s.push('<polygon points="'+top.concat(bot.reverse()).map(function(q){return q[0].toFixed(1)+','+q[1].toFixed(1);}).join(' ')+'" style="fill:'+color+';opacity:'+opq+'"/>');});};
   var fillBand=function(lo,hi,color){var a=clipPts(lo,xmin,xmax),b=clipPts(hi,xmin,xmax);
     if(a.length<2||b.length<2)return;
     var top=b.map(function(p){return X(p.x).toFixed(1)+','+Y(pv(p)).toFixed(1);});
     var bot=a.map(function(p){return X(p.x).toFixed(1)+','+Y(pv(p)).toFixed(1);}).reverse();
     s.push('<polygon class="rmfill" points="'+top.concat(bot).join(' ')+'" style="fill:'+color+'"/>');};

   // Min/mean/max behave like latency's p50/p95/p99: summary -> σ-shell + mean line per
   // level; all -> per-run lines per level, tagged so hovering one bolds that run's whole
   // min/mean/max triple (global .rln[data-run] handler). The one extra: in all mode, when
   // both min and max are on, shade each run's own min->max span (arm tint, additive opacity
   // so overlaps deepen and an outlier stays faint).
   var drawArm=function(a){
     if(state.rmin&&state.rmax && state.plot==='all'){
       var mn=runsOf(a,'Min')||[], mx=runsOf(a,'Max')||[], n=Math.min(mn.length,mx.length);
       for(var i=0;i<n;i++) fillBand(mn[i],mx[i],tintOf(a));
     }
     LV.forEach(function(L){ if(!lvOn(L[0]))return; var w=L[0], col=shadeOf(a,L[1]);
       if(state.plot==='all'){ (runsOf(a,w)||[]).forEach(function(pl,ri){ line(pl,col,'rln',a+'#'+ri); }); }
       else { shell(mean(a,w),col); (line as any)(mean(a,w),col,'ln'); }
     });
   };

   s.push('<line class="axis" x1="'+x0+'" y1="'+yt+'" x2="'+x0+'" y2="'+yb+'"/>');
   s.push('<line class="axis" x1="'+x0+'" y1="'+yb+'" x2="'+x1+'" y2="'+yb+'"/>');
   xticks();
   s.push('<text class="axtitle" x="'+((x0+x1)/2)+'" y="'+(H-4)+'" text-anchor="middle">'+xTitle+'</text>');
   s.push('<text class="axtitle" transform="rotate(-90 '+lx+' '+((yt+yb)/2)+')" x="'+lx+'" y="'+((yt+yb)/2)+'" text-anchor="middle">remote '+unit+' by node</text>');
   ARMS.forEach(function(a){ if(armOn(a)) drawArm(a); });

   // --- y2: node skew = max−min spread ÷ the run's INITIAL across-node mean (ratio, dimensionless,
   // decays to 0 at completion) OR max−min spread (delta, bytes) —
   // mutually exclusive; delta auto-scales its own MB/GB/TB unit independently of y1. ---
   var fmtMB=function(v){return v>=1048576?(v/1048576).toFixed(1)+' TB':v>=1024?(v/1024).toFixed(1)+' GB':Math.round(v)+' MB';};
   var Yr=null, y2mode=state.rratio?'Ratio':(state.rdelta?'Delta':null), y2fmt=null;
   var y2pick=function(a){return mean(a,y2mode);};
   if(y2mode){
     var rmx=0; ARMS.forEach(function(a){if(!armOn(a))return;
       var scan=function(pl){(pl||[]).forEach(function(p){var v=pv(p);if(v>rmx)rmx=v;});};
       if(state.plot==='all') (runsOf(a,y2mode)||[]).forEach(scan); else scan(y2pick(a));});
     if(rmx>0){
       var runit='MB',rdiv=1;
       if(y2mode==='Delta'){ if(rmx>=1048576){runit='TB';rdiv=1048576;} else if(rmx>=1024){runit='GB';rdiv=1024;} }
       var rstep=niceStep(rmx/4), rtop=Math.ceil(rmx/rstep)*rstep||1;
       Yr=function(v){return yb-(v/rtop)*(yb-yt);};
       y2fmt=(y2mode==='Delta')?function(v){return 'Δ '+fmtMB(v);}:function(v){return (Math.round(v*100)/100)+'×';};
       for(var rv=0;rv<=rtop+1e-9;rv+=rstep)
         s.push('<text class="y2tick" x="'+(x1+4)+'" y="'+(Yr(rv)+2).toFixed(1)+'" text-anchor="start">'+(y2mode==='Delta'?axn(rv/rdiv):(axn(rv)+'×'))+'</text>');
       s.push('<text class="axtitle" transform="rotate(-90 '+(x1+30)+' '+((yt+yb)/2)+')" x="'+(x1+30)+'" y="'+((yt+yb)/2)+'" text-anchor="middle">'+(y2mode==='Delta'?('max−min '+runit+' by node'):'skew ÷ initial mean')+'</text>');
       var rline=function(pl,color,key){ if(!pl)return; var cc=clipPts(pl,xmin,xmax); if(cc.length<2)return;
         var d=cc.map(function(p,i){return (i?'L':'M')+X(p.x).toFixed(1)+' '+Yr(pv(p)).toFixed(1);}).join(' ');
         s.push('<path class="mbln'+(key!=null?' rln':'')+'"'+(key!=null?' data-run="'+key+'"':'')+' style="stroke:'+color+'" d="'+d+'"/>');
         if(key!=null) hits.push('<path class="rlnhit" data-run="'+key+'" d="'+d+'"/>'); };
       ARMS.forEach(function(a){ if(!armOn(a))return; var col=ratioCol(a);
         if(state.plot==='all'){ (runsOf(a,y2mode)||[]).forEach(function(pl,ri){ rline(pl,col,a+'#'+ri); }); }
         else { rline(mean(a,y2mode),col,null); }
       });
     }
   }

   // --- shared cursor + drag-to-zoom (mean bytes on y1, skew/delta on y2) ---
   (function(){
     var cser=[];
     // One y1 readout per ENABLED level (min/mean/max), each in its level's shade and named
     // in the label ("max 8.2 GB"), mirroring the drawn lines — not a single hard-coded mean.
     ARMS.forEach(function(a){ if(!armOn(a))return;
       LV.forEach(function(L){ if(!lvOn(L[0]))return; var w=L[0];
         cser.push({color:shadeOf(a,L[1]), y:function(v){return Y(v);},
           fmt:function(v){return w.toLowerCase()+' '+fmtMB(v);},
           at:function(cxv){var e=effRun(a); if(e==='skip')return null;
             var c=e!=null?((runsOf(a,w)||[])[e]||[]):mean(a,w);
             return (c&&c.length)?(e!=null?interp2(c,cxv):interp(c,cxv)):null;}});
       }); });
     if(Yr){ ARMS.forEach(function(a){ if(!armOn(a))return;
       cser.push({color:ratioCol(a), y:function(v){return Yr(v);}, fmt:y2fmt,
         at:function(cxv){var e=effRun(a); if(e==='skip')return null;
           var c=e!=null?((runsOf(a,y2mode)||[])[e]||[]):mean(a,y2mode);
           return (c&&c.length)?(e!=null?interp2(c,cxv):interp(c,cxv)):null;}}); }); }
     var d0=mean(armOn('ctl')?'ctl':'exp','Mean');
     var g0=(d0&&d0.length)?d0.map(function(p){return p.x;}):null;
     CURSORS['__remote__']={x0:x0,x1:x1,xmin:xmin,xmax:xmax,yt:yt,yb:yb,W:W,gridX:g0,series:cser,
       head:function(cxv){var h=elapsed?(Math.round(cxv)+'s'):(Math.round(cxv)+'%'); var _r=isoRun();
         if(_r)h+=' · '+(RC.dual?((LAB[_r.arm]||_r.arm)+' '):'')+'run '+(_r.idx+1); return h;}};
   })();
   s.push('<rect class="scrubhit" x="0" y="0" width="'+W+'" height="'+H+'" fill="transparent" pointer-events="all" '+
     'data-op="__remote__" data-x0="'+x0+'" data-x1="'+x1+'" data-xmin="'+xmin+'" data-xmax="'+xmax+'" data-yt="'+yt+'" data-yb="'+yb+'"/>');
   s.push('<g class="cursorlayer" data-op="__remote__"></g>');
   if(hits.length) s.push(hits.join(''));
   s.push('</svg>');
   host.innerHTML=s.join('');
 }
 function redraw(){CURSORS={};Object.keys(D).forEach(function(op){
   var el=document.querySelector('.chart[data-op="'+op+'"]');if(el)el.innerHTML=build(op);});
   buildDownload(); buildRemote();
   // A pin only makes sense in all-runs mode with its arm shown; drop it otherwise. Then
   // re-assert the isolation, since rebuilding the charts replaced the .rln nodes (and their
   // .hon bold) — this keeps a pinned run bolded across control toggles.
   if(PIN && (state.plot!=='all' || !armOn(PIN.arm))) PIN=null;
   applyIso();}
 // Re-render the per-op tables to match the arm selection (aggregate over the shown arm's
 // runs). Reads ctx from RC.
 function refreshTables(){
   var C=RC.ctx; if(!C)return;
   Object.keys(D).forEach(function(op){
     var box=document.querySelector('.optbl[data-op="'+op+'"]'); if(!box)return;
     box.innerHTML=op_time_table(op, C.series[op], C.dual, C.control_label, C.experiment_label||"B", C.timeRows, state.armMode);
   });
   var dlt=document.querySelector('.dltbl'); if(dlt) dlt.innerHTML=download_tables(C, state.armMode);
 }
 // Zoom range is driven entirely by drag-to-select and click-to-reset; this just
 // reflects the zoomed state on <body> so the plot shows the zoom-out cursor.
 function syncRange(){ document.body.classList.toggle('zoomed', !isFull()); }
 // The single arm eligible for per-run selection, and its run count. Individual
 // runs are offered only when one arm is in view: a single-arm report always, or
 // A/B once the arm cycle narrows to A or B. In A/B-both there's no such arm, so
 // no per-run entries (run i of A and run i of B are unrelated executions).
 function sync(){
   document.querySelectorAll('[data-pct]').forEach(function(b){b.classList.toggle('on',!!state[(b as any).dataset.pct]);});
   document.querySelectorAll('[data-scale]').forEach(function(b){b.classList.toggle('on',state.scale===(b as any).dataset.scale);});
   document.querySelectorAll('[data-xmode]').forEach(function(b){b.classList.toggle('on',state.xmode===(b as any).dataset.xmode);});
   document.querySelectorAll('[data-plot]').forEach(function(b){b.classList.toggle('on',state.plot===(b as any).dataset.plot);});
   // The arm-cycle button is gone (double-click cycles now); reflect which arm(s) are shown as
   // a body class so the top arm-bar chips can dim the hidden arm (the single arm control).
   document.body.classList.toggle('arm-a', state.armMode==='A');
   document.body.classList.toggle('arm-b', state.armMode==='B');
   var qb=document.querySelector('[data-qps]'); if(qb) qb.classList.toggle('on',state.qps);
   ['min','mean','max','ratio','delta'].forEach(function(w){var rb=document.querySelector('[data-remote-'+w+']'); if(rb) rb.classList.toggle('on',!!state['r'+w]);});
   PMETS.forEach(function(m){document.body.classList.toggle('hide-'+m,!state[m]);});
   syncRange();
   persistCtrl();   // control changes funnel through sync() -> keep the slug's ctrl in step
 }
 document.addEventListener('click',function(e){
   var b=(e.target as any).closest('[data-pct],[data-qps],[data-scale],[data-xmode],[data-plot],[data-remote-min],[data-remote-mean],[data-remote-max],[data-remote-ratio],[data-remote-delta]');if(!b)return;
   if(b.dataset.pct){state[b.dataset.pct]=!state[b.dataset.pct];}
   else if(b.dataset.plot){state.plot=b.dataset.plot;}   // summary | runs
   else if(b.hasAttribute('data-qps')){state.qps=!state.qps;}
   else if(b.hasAttribute('data-remote-min')){state.rmin=!state.rmin;}
   else if(b.hasAttribute('data-remote-mean')){state.rmean=!state.rmean;}
   else if(b.hasAttribute('data-remote-max')){state.rmax=!state.rmax;}
   else if(b.hasAttribute('data-remote-ratio')){state.rratio=!state.rratio; if(state.rratio)state.rdelta=false;}   // ratio/delta mutually exclusive
   else if(b.hasAttribute('data-remote-delta')){state.rdelta=!state.rdelta; if(state.rdelta)state.rratio=false;}
   else if(b.dataset.xmode){state.xmode=b.dataset.xmode;}
   else{state.scale=b.dataset.scale;}
   sync();redraw();
 },{signal:AC.signal});
 // ---- Synced cursor ----
 var SVGNS='http://www.w3.org/2000/svg';
 var lastCx=null;
 // interp2 is imported (== core _iXY, which adds a null-guard superset over this).
 function mk(name,attrs,text){var e=document.createElementNS(SVGNS,name);
   for(var k in attrs)e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=text;return e;}
 function clearCursors(){var ls=document.querySelectorAll('.cursorlayer');
   for(var i=0;i<ls.length;i++){while(ls[i].firstChild)ls[i].removeChild(ls[i].firstChild);}
   var cap=document.querySelector('[data-dlcap]') as any; if(cap) cap.style.display='none';}
 // Registry-driven: draw the vertical + head + each registered series' dot/label on
 // EVERY chart's cursor layer, so hovering any plot annotates all of them in sync.
 function drawCursor(xv,noClear?){
   for(var op in CURSORS){ var c=CURSORS[op];
     var hit=document.querySelector('.scrubhit[data-op="'+op+'"]'); if(!hit||!(hit as any).ownerSVGElement)continue;
     var layer=(hit as any).ownerSVGElement.querySelector('.cursorlayer[data-op="'+op+'"]'); if(!layer)continue;
     if(!noClear)while(layer.firstChild)layer.removeChild(layer.firstChild);
     // Every chart now uses viewBox width 760 (an earlier layout mixed 520/760), so this
     // is a constant ~1.46x cursor-text/dot scale — kept as c.W/520 rather than inlined so
     // it stays correct if a chart's viewBox width ever diverges again.
     var fs=(c.W||760)/520, r=(2.3*fs);
     var cxv=Math.max(c.xmin,Math.min(xv,c.xmax));
     var px=c.x0+((cxv-c.xmin)/(c.xmax-c.xmin))*(c.x1-c.x0);
     layer.appendChild((mk as any)('line',{'class':'scrub',x1:px.toFixed(1),y1:c.yt,x2:px.toFixed(1),y2:c.yb}));
     var hd=c.head&&c.head(cxv);
     if(hd){var ht=(mk as any)('text',{'class':'curhead',x:px.toFixed(1),y:(c.yt-4),'text-anchor':'middle'},hd);ht.style.fontSize=(6*fs).toFixed(1)+'px';layer.appendChild(ht);}
     var placed=[];   // label boxes already drawn, so close ones can be nudged aside
     for(var si=0;si<c.series.length;si++){ var sp=c.series[si]; var v=sp.at(cxv);
       if(v==null||isNaN(v))continue; var py=sp.y(v); if(py==null||isNaN(py))continue;
       var dot=(mk as any)('circle',{'class':'curdot',r:r.toFixed(2),cx:px.toFixed(1),cy:py.toFixed(1)}); dot.style.fill=sp.color; layer.appendChild(dot);
       var txt=sp.fmt(v), fsz=6.5*fs, w=txt.length*fsz*0.58, lx=px+r+1, ly=py-2;
       // If a value sits near the very top, keep its label inside the plot so it doesn't
       // land on a plot's own top label; otherwise place it just above the dot.
       if(ly < c.yt+3) ly = py + fsz + 1;
       // Nudge right if it would overlap a label already placed at this x (close values).
       for(var pi=0;pi<placed.length;pi++){ var pl=placed[pi];
         if(Math.abs(pl.y-ly)<fsz && lx<pl.x+pl.w && lx+w>pl.x){ lx=pl.x+pl.w+2*fs; } }
       placed.push({x:lx,y:ly,w:w});
       var lab=(mk as any)('text',{'class':'curlab',x:lx.toFixed(1),y:ly.toFixed(1)}, txt); lab.style.fill=sp.color; lab.style.fontSize=fsz.toFixed(1)+'px'; layer.appendChild(lab);
     }
     // Compact progress strip: its own SVG labels are squished flat, so surface the y1
     // (left-axis) intercept value(s) as an upright HTML chip at the cursor x instead.
     if(op==='__dl__'){
       var cap=document.querySelector('[data-dlcap]') as any, wrap=cap&&cap.parentElement;
       if(cap && wrap && wrap.classList.contains('stuck')){
         var parts=[];
         for(var yi=0;yi<c.series.length;yi++){ var ys=c.series[yi]; if(!ys.y1)continue;
           var yv=ys.at(cxv); if(yv==null||isNaN(yv))continue;
           parts.push('<span style="color:'+ys.color+'">'+ys.fmt(yv)+'</span>'); }
         if(parts.length){ cap.innerHTML=parts.join(' '); cap.style.left=(px/(c.W||760)*100)+'%'; cap.style.display='block'; }
         else cap.style.display='none';
       } else if(cap) cap.style.display='none';
     }
   }
 }
 // ---- Drag-to-zoom (elapsed mode only): drag a horizontal band to set range ----
 var drag=null, clickTimer=null;
 function resetZoom(){ if(!isFull()){ state.range.start=0; state.range.end=XMAX; syncRange(); redraw(); } }
 // Cycle the arm(s) shown: A+B -> A -> B -> A+B (dual only). Shared by the control-bar arm
 // button and the on-plot double-click.
 function cycleArm(){
   if(!RC.dual) return;
   state.armMode = state.armMode==='both'?'A':state.armMode==='A'?'B':'both';
   sync(); redraw(); refreshTables();
 }
 // Toggle the plot between summary (mean+band) and all-runs.
 function toggleSummaryRuns(){
   state.plot = state.plot==='avg' ? 'all' : 'avg';
   sync(); redraw(); refreshTables();
 }
 // A plain single click on the plot (double-click toggles arms; the zoom is reset via the
 // control-bar button or Escape). Priority: un-pin a pinned run, else pin the run under the
 // pointer (it stays isolated while you scrub other times without staying on its thin line),
 // else (empty area) toggle summary <-> all-runs. Pinning reuses the isolation the synced
 // cursor already understands (PIN wins over the transient HOVER in isoRun()).
 function plotClick(){
   if(PIN){ PIN=null; applyIso(); return; }
   if(HOVER){ PIN={arm:HOVER.arm, idx:HOVER.idx}; applyIso(); return; }
   toggleSummaryRuns();
 }
 function hitToElapsed(hit,e){
   var x0=+hit.getAttribute('data-x0'),x1=+hit.getAttribute('data-x1'),xmin=+hit.getAttribute('data-xmin'),xmax=+hit.getAttribute('data-xmax');
   var svg=hit.ownerSVGElement,r=svg.getBoundingClientRect();
   var vx=(e.clientX-r.left)/r.width*svg.viewBox.baseVal.width;
   var xv=xmin+(vx-x0)/(x1-x0)*(xmax-xmin);if(xv<xmin)xv=xmin;if(xv>xmax)xv=xmax;return xv;
 }
 // Snap an elapsed value to the nearest ACTUAL sample of the dragged chart (its cursor grid,
 // = the union of sample times), matching the hover cursor's snapping — so a zoom bound is
 // exactly the reading the cursor showed when pressed/released, and the drag preview equals
 // what you'll get. Falls back to the raw value if the grid isn't available.
 function snapGrid(op,x){ var c=CURSORS[op], g=c&&c.gridX;
   if(!g||!g.length) return x;
   var best=g[0], bd=Math.abs(best-x);
   for(var i=1;i<g.length;i++){ var d=Math.abs(g[i]-x); if(d<bd){bd=d;best=g[i];} }
   return best; }
 function drawSelection(op,a,b,noClear){
   var hit=document.querySelector('.scrubhit[data-op="'+op+'"]');if(!hit)return;
   var layer=(hit as any).ownerSVGElement.querySelector('.cursorlayer[data-op="'+op+'"]');if(!layer)return;
   if(!noClear)while(layer.firstChild)layer.removeChild(layer.firstChild);
   var x0=+hit.getAttribute('data-x0'),x1=+hit.getAttribute('data-x1'),xmin=+hit.getAttribute('data-xmin'),xmax=+hit.getAttribute('data-xmax');
   var yt=+hit.getAttribute('data-yt'),yb=+hit.getAttribute('data-yb');
   function px(v){return x0+((v-xmin)/(xmax-xmin))*(x1-x0);}
   var pa=px(Math.min(a,b)),pb=px(Math.max(a,b));
   layer.appendChild((mk as any)('rect',{'class':'selrect',x:pa.toFixed(1),y:yt,width:(pb-pa).toFixed(1),height:(yb-yt)}));
 }
 document.addEventListener('mousedown',function(e){
   // Resolve the chart's scrub-rect even when the press lands on a run's hit-path (which sits
   // on top), so clicking a run line is tracked as a click (-> pin) rather than swallowed.
   var t=(e.target as any);
   var hit=t.closest?t.closest('.scrubhit'):null;
   if(!hit && t.closest && t.closest('[data-run]') && t.ownerSVGElement)
     hit=t.ownerSVGElement.querySelector('.scrubhit');
   if(!hit)return;
   // Track every press: a plain click (no drag) resets the zoom, a drag zooms.
   // Drag-to-zoom itself is elapsed-only (handled on move/up).
   var dop=hit.getAttribute('data-op');
   drag={hit:hit,op:dop,startXv:snapGrid(dop,hitToElapsed(hit,e)),
         startClientX:e.clientX,curXv:null,moved:false};
   e.preventDefault();
 },{signal:AC.signal});
 document.addEventListener('mousemove',function(e){
   if(drag){                                          // dragging: draw selection + live readout
     var xv=snapGrid(drag.op,hitToElapsed(drag.hit,e));drag.curXv=xv;
     if(Math.abs(e.clientX-drag.startClientX)>4)drag.moved=true;
     if(drag.moved&&state.xmode==='elapsed'){        // zoom-select is elapsed-only
       clearCursors();
       drawSelection(drag.op,drag.startXv,xv,true);
       // Keep the snapped cursor readout on the leading edge so you can see the value
       // you'd zoom to if you released now (same snapping as the final bound).
       drawCursor(xv,true);
     }
     return;
   }
   // The cursor must draw over run lines too: a run's fat hit-path (.rlnhit) sits ON TOP of
   // the scrub hit-rect, so when the pointer is over a run, reach the same chart's scrubhit
   // via the shared <svg> rather than giving up (which used to drop the line over a run).
   var t=(e.target as any);
   var hit=t.closest?t.closest('.scrubhit'):null;
   if(!hit && t.closest && t.closest('[data-run]') && t.ownerSVGElement)
     hit=t.ownerSVGElement.querySelector('.scrubhit');
   if(!hit)return;
   var op=hit.getAttribute('data-op'), c=CURSORS[op]; if(!c)return;
   var svg=hit.ownerSVGElement,r=svg.getBoundingClientRect();
   var vx=(e.clientX-r.left)/r.width*svg.viewBox.baseVal.width;
   var xv=c.xmin+(vx-c.x0)/(c.x1-c.x0)*(c.xmax-c.xmin);if(xv<c.xmin)xv=c.xmin;if(xv>c.xmax)xv=c.xmax;
   if(c.gridX&&c.gridX.length){var g=c.gridX,best=g[0],bd=Math.abs(best-xv);
     for(var i=1;i<g.length;i++){var dd=Math.abs(g[i]-xv);if(dd<bd){bd=dd;best=g[i];}}xv=best;}
   if(xv===lastCx)return;lastCx=xv;
   (drawCursor as any)(xv);
 },{signal:AC.signal});
 document.addEventListener('mouseup',function(e){
   if(!drag)return;var d=drag;drag=null;clearCursors();
   if(d.moved && state.xmode==='elapsed' && d.curXv!=null){       // drag -> zoom
     // Bounds were snapped to actual samples at capture (matching the cursor), so the
     // window is exactly the readings shown during the drag. Require at least one sample
     // of width (distinct grid points) so a jittery click doesn't zoom to nothing.
     var a=Math.min(d.startXv,d.curXv), b=Math.max(d.startXv,d.curXv);
     if(b>a){state.range.start=a;state.range.end=b;syncRange();redraw();}
   } else if(!d.moved){                                           // plain click (no drag)
     // Defer so a double-click (arm toggle) can cancel the single-click action.
     clearTimeout(clickTimer); clickTimer=setTimeout(plotClick,220);
   }
 },{signal:AC.signal});
 // Double-click ANYWHERE in the report toggles the arm(s) shown (zoom is reset via the button
 // or Escape) — you don't have to be on a chart. Excludes interactive controls, links, and
 // tables so their own double-click semantics (buttons, selecting a number) are preserved.
 document.addEventListener('dblclick',function(e){
   var t=(e.target as any);
   if(t.closest && t.closest('button,select,input,textarea,a,.armchip,[data-copy],.tbl')) return;
   clearTimeout(clickTimer); cycleArm();
 },{signal:AC.signal});
 // Control-bar "reset zoom" button (shown only while zoomed).
 document.addEventListener('click',function(e){
   if((e.target as any).closest&&(e.target as any).closest('[data-unzoom]')) resetZoom();
 },{signal:AC.signal});
 // Collapse/expand the Progress Distribution chart — via its own title or the "show graph" link
 // in the progress-distribution table. It expands in place (right below the link), so we do NOT
 // move the viewport (scrolling it into view would push the link away under the finger).
 function togglePdist(){
   var w=document.querySelector('.pdist'); if(!w)return;
   w.classList.toggle('collapsed');
   document.body.classList.toggle('pd-open', !w.classList.contains('collapsed'));
 }
 document.addEventListener('click',function(e){
   var sh=(e.target as any).closest&&(e.target as any).closest('[data-pdist-show]');
   if(sh){ e.preventDefault(); togglePdist(); return; }
   if((e.target as any).closest&&(e.target as any).closest('[data-pdist-toggle]')) togglePdist();
 },{signal:AC.signal});
 document.addEventListener('mouseout',function(e){
   if(drag)return;
   // Leaving the SVG can happen with the pointer over a run's fat hit-path (.rlnhit), which
   // is a sibling of the scrub-rect layered on top — so closest('.scrubhit') misses it and
   // the cursor would strand. Mirror the mousedown/mousemove fallback: treat a [data-run]
   // target inside a chart's <svg> as a chart exit too.
   var t=(e.target as any);
   if(t.closest && (t.closest('.scrubhit') || (t.closest('[data-run]') && t.ownerSVGElement))){
     lastCx=null;clearCursors();
   }
 },{signal:AC.signal});
 // ---- Click-to-copy (provenance cells) + copy-link (arms -> URL hash) ----
 // copyText is imported from ../clipboard (shared with the bootstrap's share-link copy).
 document.addEventListener('click',function(e){
   var el=(e.target as any).closest?(e.target as any).closest('[data-copy]'):null;if(!el)return;
   copyText(el.getAttribute('data-copy'));
   el.classList.add('copied');setTimeout(function(){el.classList.remove('copied');},900);
 },{signal:AC.signal});
 // Publish this render's cursor repaint so the module-scope run-hover listeners can refresh
 // the labels the instant HOVER changes, even with the pointer resting still on a run.
 ACTIVE = { redrawCursor: function(){ if(lastCx!=null) drawCursor(lastCx); }, resetZoom: function(){ resetZoom(); } };
 sync();redraw();
})();
}
