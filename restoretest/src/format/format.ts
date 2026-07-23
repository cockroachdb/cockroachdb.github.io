// Formatting helpers (mirror the Python formatters exactly, incl. glyphs).
// Shared by the render layer (tables/svg) and — as a follow-up — the chart.
import { isnan } from "../util";

function _fmt(v, nd?){
  nd = nd === undefined ? 1 : nd;
  if (v === null || v === undefined || isnan(v)) return "-";
  return v.toFixed(nd);
}
function esc(s){
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#x27;");
}
function _commas(x){ return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function _num(v){
  if (v === null || v === undefined || isnan(v)) return "–";
  if (v >= 100) return _commas(Math.round(v));
  if (v >= 10) return String(Math.round(v));
  return v.toFixed(1);
}
function _sms(v){
  if (v === null || v === undefined || isnan(v)) return "–";
  return (v >= 0 ? "+" : "−") + _num(Math.abs(v));
}
function _pct(v, nd?, signed?){
  nd = nd === undefined ? 0 : nd;
  signed = signed === undefined ? true : signed;
  if (v === null || v === undefined || isnan(v)) return "–";
  var s = signed ? (v>=0?"+":"") + v.toFixed(nd) : v.toFixed(nd);
  return s + "%";
}
// Compact p: 0.007 -> .007, 1e-5 -> 1e-05 (matches Python's %.2g / %.0e + strip).
function _g2(p){
  // Emulate Python "%.2g".
  if (p === 0) return "0";
  var exp = Math.floor(Math.log10(Math.abs(p)));
  var s;
  if (exp < -4 || exp >= 2){
    s = p.toExponential(1);
    // normalize exponent to at least 2 digits like Python (e.g. 1e-05, 1.2e+02)
    s = s.replace(/e([+-])(\d)$/, "e$10$2");
  } else {
    var digits = Math.max(0, 1 - exp);
    s = p.toFixed(digits);
    // trim trailing zeros / dot like %g
    if (s.indexOf(".") >= 0) s = s.replace(/0+$/,"").replace(/\.$/,"");
  }
  return s;
}
function _e0(p){
  var s = p.toExponential(0);
  return s.replace(/e([+-])(\d)$/, "e$10$2");
}
function _pfmt(p){
  if (p === null || p === undefined || isnan(p)) return "–";
  var s = p >= 1e-4 ? _g2(p) : _e0(p);
  return s.indexOf("0.") === 0 ? s.slice(1) : s;
}
function _nice_step(x){
  if (x <= 0) return 1.0;
  var e = Math.pow(10, Math.floor(Math.log10(x)));
  var f = x/e;
  var nf = f<1.5?1:f<3?2:f<7?5:10;
  return nf*e;
}

// Compact duration "6m 32s" / "45s" from a seconds value. Shared by the arm ribbon chip and
// the recently-viewed modal (avg time-to-100% + avg run duration).
function fmtDur(s){
  if (s == null) return "";
  s = Math.round(s);
  var m = Math.floor(s / 60);
  return m ? (m + "m" + (s % 60 ? (" " + (s % 60) + "s") : "")) : (s + "s");
}
// Relative age of a run from its "yymmdd-HHMMSS" invocation stamp: "3d ago" / "5h ago" /
// "12m ago" / "just now" (or "" when the stamp is unparseable). The stamp is treated as local
// time — same components armTsFields() displays; the coarse d/h/m granularity makes any TZ
// skew immaterial. Future stamps (clock skew) clamp to "just now".
function fmtAgo(ts){
  var m = /^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(ts || "");
  if (!m) return "";
  var then = new Date(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  var diff = Date.now() - then;
  if (diff < 0) diff = 0;
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  var days = Math.floor(hrs / 24);
  return days + "d ago";
}

// Compact one `--set` override for the ribbon chip / recently-viewed card: drop a trailing
// `.enabled` from the key and strip vowels (kv.range_split.by_load.enabled -> kv.rng_splt.by_ld),
// and abbreviate the value (true->t, false->f, else as-is).
function _shortSetting(k, v){
  var name = String(k).replace(/\.enabled$/, "").replace(/[aeiou]/gi, "");
  var val = (v === true || v === "true") ? "t" : (v === false || v === "false") ? "f" : String(v);
  return name + "=" + val;
}
// A whole settings map -> space-joined compact tokens (empty string when there are none).
function fmtSettings(settings){
  if (!settings) return "";
  var ks = Object.keys(settings);
  if (!ks.length) return "";
  return ks.map(function(k){ return _shortSetting(k, settings[k]); }).join(" ");
}

// Compact elapsed label (s / m / h), used by time_rows and the time tables.
function _tlabel(t){
  if (t < 60) return Math.round(t)+"s";
  var m = Math.round(t/60);
  if (m < 60) return m+"m";
  var h = Math.floor(m/60), mm = m%60;
  return h+"h"+(mm?mm+"m":"");
}

export { _fmt, esc, _commas, _num, _sms, _pct, _g2, _e0, _pfmt, _nice_step, _tlabel, fmtDur, fmtAgo, fmtSettings };
