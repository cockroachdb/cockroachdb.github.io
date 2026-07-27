// Static no-JS fallback SVG (the interactive chart re-renders on load).
import { esc, _num, _nice_step } from "../format/format";
import { SERIES_VAR } from "../model/constants";

function bake_svg(op, series, big){
  var W = 760, H = 320;                  // all charts share one size
  var x0 = 52, x1 = 690, yt = 22, yb = 284;
  var mets = ["p50","p99"];
  // Arms actually present in this series (ctl always; exp/c only when they carry data), so the
  // baked fallback draws however many arms the report has without a hardcoded pair.
  var armList = ["ctl","exp","c"].filter(function(arm){
    return mets.some(function(m){ return (series.el[arm+"_"+m] || []).length; }); });
  var keys = [];
  mets.forEach(function(m){ armList.forEach(function(arm){ keys.push([arm,m]); }); });
  function pts(arm,m){ return series.el[arm+"_"+m] || []; }
  var hi = [];
  keys.forEach(function(km){ pts(km[0],km[1]).forEach(function(p){ hi.push(p.m+p.s); }); });
  if (!hi.length) return "";
  var ymax = Math.max.apply(null,hi)*1.02;
  var step = _nice_step(ymax/5.0);
  ymax = Math.ceil(ymax/step)*step || 1.0;
  var xs = [];
  keys.forEach(function(km){ pts(km[0],km[1]).forEach(function(p){ xs.push(p.x); }); });
  var xmax = xs.length ? Math.max.apply(null,xs) : 1.0; xmax = xmax || 1.0;
  function Y(v){ return yb - (v/ymax)*(yb-yt); }
  function X(v){ return x0 + (v/xmax)*(x1-x0); }
  var P = [];
  P.push('<svg viewBox="0 0 '+W+' '+H+'" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="latency for '+esc(op)+'">');
  var v = 0.0;
  while (v <= ymax+1e-9){
    var y = Y(v);
    P.push('<line class="grid" x1="'+x0+'" y1="'+y.toFixed(1)+'" x2="'+x1+'" y2="'+y.toFixed(1)+'"/>');
    P.push('<text class="ytick" x="'+(x0-5)+'" y="'+(y+2).toFixed(1)+'" text-anchor="end">'+(v===0?"0":_num(v))+'ms</text>');
    v += step;
  }
  P.push('<line class="axis" x1="'+x0+'" y1="'+yt+'" x2="'+x0+'" y2="'+yb+'"/>');
  P.push('<line class="axis" x1="'+x0+'" y1="'+yb+'" x2="'+x1+'" y2="'+yb+'"/>');
  var es = _nice_step(xmax/5.0);
  var ev = 0.0;
  while (ev <= xmax+1e-9){
    var x = X(ev);
    P.push('<line class="grid" x1="'+x.toFixed(1)+'" y1="'+yt+'" x2="'+x.toFixed(1)+'" y2="'+yb+'" opacity="0.5"/>');
    P.push('<text class="xtick" x="'+x.toFixed(1)+'" y="'+(yb+9)+'" text-anchor="middle">'+ev.toFixed(0)+'s</text>');
    ev += es;
  }
  P.push('<text class="axtitle" x="'+((x0+x1)/2).toFixed(1)+'" y="'+(H-4)+'" text-anchor="middle">elapsed (s)</text>');
  keys.forEach(function(km){
    var pp = pts(km[0],km[1]);
    if (pp.length >= 2){
      var vv = SERIES_VAR[km[0]+"|"+km[1]];
      var d = pp.map(function(p,i){ return (i===0?"M":"L")+X(p.x).toFixed(1)+" "+Y(p.m).toFixed(1); }).join(" ");
      P.push('<path class="ln" style="stroke:var('+vv+')" fill="none" d="'+d+'"/>');
    }
  });
  P.push('</svg>');
  return P.join("");
}

export { bake_svg };
