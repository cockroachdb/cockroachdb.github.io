// Small numeric helpers shared across the compute + format layers.
// Verbatim from the original CORE block.

// Python's round(x, nd): round-half-to-even on the scaled value. Matches CPython
// for the non-exact-half cases we hit here (means/std of interpolated latencies);
// only exact N.5 at the rounded digit differs from JS Math.round, and we handle
// that with the half-even branch below.
function pyRound(x, nd){
  if (x === null || x === undefined || (typeof x === "number" && isNaN(x))) return x;
  var f = Math.pow(10, nd);
  var v = x * f;
  var fl = Math.floor(v);
  var diff = v - fl;
  var r;
  if (diff > 0.5) r = fl + 1;
  else if (diff < 0.5) r = fl;
  else r = (fl % 2 === 0) ? fl : fl + 1;   // half to even
  return r / f;
}
var NAN = NaN;
function isnan(x){ return typeof x === "number" && isNaN(x); }
function _n(v){ return (v === null || v === undefined) ? null : +v; }
function _ln(a, b, t){ return (a == null || b == null) ? (a != null ? a : b) : a + (b-a)*t; }
function clean(x){ return isnan(x) ? null : x; }

export { pyRound, NAN, isnan, _n, _ln, clean };
