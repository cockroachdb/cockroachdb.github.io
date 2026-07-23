// Robust statistics: quantiles, Mann-Whitney U, Hodges-Lehmann, BH-FDR, summaries.
// Verbatim from the original CORE block.
import { NAN, isnan } from "../util";

function quantile(xs, q){
  var s = xs.slice().sort(function(a,b){return a-b;});
  var n = s.length;
  if (n === 0) return null;
  if (n === 1) return s[0]*1.0;
  var pos = (n-1)*q;
  var lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return s[lo]*1.0;
  return s[lo] + (pos-lo)*(s[hi]-s[lo]);
}
function median(xs){ return quantile(xs, 0.5); }

// --------------------------------------------------------------------------
// Mann-Whitney U (exact via DP over doubled midranks; normal approx w/ ties)
// --------------------------------------------------------------------------

function _midranks(vals){
  var n = vals.length;
  var order = vals.map(function(_,i){return i;}).sort(function(a,b){return vals[a]-vals[b];});
  var ranks = new Array(n).fill(0.0);
  var i = 0;
  while (i < n){
    var j = i;
    while (j+1 < n && vals[order[j+1]] === vals[order[i]]) j++;
    var r = (i+j)/2.0 + 1.0;
    for (var k=i;k<=j;k++) ranks[order[k]] = r;
    i = j+1;
  }
  return ranks;
}
function _tie_counts(vals){
  var counts = {};
  for (var i=0;i<vals.length;i++){ var v=vals[i]; counts[v]=(counts[v]||0)+1; }
  var out=[]; for (var kk in counts){ if (counts[kk]>1) out.push(counts[kk]); }
  return out;
}
// erfc approximation (Numerical Recipes erfcc; |frac err| < 1.2e-7). Only used
// on the normal-approx branch (large n); the exact branch needs no erfc.
function erfc(x){
  var z = Math.abs(x);
  var t = 1.0/(1.0+0.5*z);
  var ans = t*Math.exp(-z*z-1.26551223+t*(1.00002368+t*(0.37409196+t*(0.09678418+
    t*(-0.18628806+t*(0.27886807+t*(-1.13520398+t*(1.48851587+
    t*(-0.82215223+t*0.17087277)))))))));
  return x >= 0 ? ans : 2.0-ans;
}
function mann_whitney(x, y, exact_max?){
  exact_max = exact_max === undefined ? 12 : exact_max;
  var n1 = x.length, n2 = y.length;
  if (n1 === 0 || n2 === 0) return [NAN, NAN, "none"];
  var pooled = x.concat(y);
  var ranks = _midranks(pooled);
  var w1 = 0; for (var i=0;i<n1;i++) w1 += ranks[i];   // rank sum of first sample
  var u1 = w1 - n1*(n1+1)/2.0;

  if (n1 <= exact_max && n2 <= exact_max){
    var r2 = ranks.map(function(r){return Math.round(2*r);});   // doubled -> ints
    var dp = [];
    for (var k=0;k<=n1;k++) dp.push(new Map());
    dp[0].set(0, 1);
    for (var ri=0;ri<r2.length;ri++){
      var r = r2[ri];
      for (var kk=n1;kk>=1;kk--){
        var src = dp[kk-1];
        if (src.size === 0) continue;
        var dst = dp[kk];
        src.forEach(function(c, s){ dst.set(s+r, (dst.get(s+r)||0)+c); });
      }
    }
    var dist = dp[n1];
    var total = 0; dist.forEach(function(c){ total += c; });
    var w2 = Math.round(2*w1);
    var pLow = 0, pHigh = 0;
    dist.forEach(function(c, s){ if (s <= w2) pLow += c; if (s >= w2) pHigh += c; });
    pLow /= total; pHigh /= total;
    var p = Math.min(1.0, 2.0*Math.min(pLow, pHigh));
    return [u1, p, "exact"];
  }
  // Normal approximation with tie correction + continuity correction.
  var N = n1+n2;
  var mu = n1*n2/2.0;
  var tieTerm = 0; _tie_counts(pooled).forEach(function(t){ tieTerm += t*t*t - t; });
  var varr = (n1*n2/12.0)*((N+1) - tieTerm/(N*(N-1)));
  if (varr <= 0) return [u1, 1.0, "normal"];
  var sigma = Math.sqrt(varr);
  var z = (Math.abs(u1-mu)-0.5)/sigma;
  var pn = erfc(z/Math.sqrt(2.0));
  return [u1, Math.min(1.0, pn), "normal"];
}

// --------------------------------------------------------------------------
// Hodges-Lehmann estimator + distribution-free CI
// --------------------------------------------------------------------------

var _uNullCache = new Map();
function _u_null_counts(m, n){
  var key = m+","+n;
  if (_uNullCache.has(key)) return _uNullCache.get(key);
  var memo = new Map();
  function f(a, b, u){
    if (u < 0) return 0;
    if (a === 0 || b === 0) return u === 0 ? 1 : 0;
    var k = a+","+b+","+u;
    if (memo.has(k)) return memo.get(k);
    var v = f(a-1, b, u-b) + f(a, b-1, u);
    memo.set(k, v);
    return v;
  }
  var out = [];
  for (var u=0; u<=m*n; u++) out.push(f(m, n, u));
  _uNullCache.set(key, out);
  return out;
}
function _hl_trim(m, n, alpha){
  var mn = m*n;
  if (m <= 12 && n <= 12){
    var counts = _u_null_counts(m, n);
    var total = 0; counts.forEach(function(c){ total += c; });
    var target = alpha/2.0*total;
    var k = 0, cum = 0;
    while (k < mn && cum + counts[k] <= target){ cum += counts[k]; k++; }
    return k;
  }
  var z = 1.959963984540054;
  var kk = Math.floor(mn/2.0 - z*Math.sqrt(mn*(m+n+1)/12.0));
  return Math.max(0, kk|0);
}
function hodges_lehmann(x_exp, x_ctl, alpha?){
  alpha = alpha === undefined ? 0.05 : alpha;
  var m = x_exp.length, n = x_ctl.length;
  if (m === 0 || n === 0) return [NAN, NAN, NAN];
  var diffs = [];
  for (var i=0;i<m;i++) for (var j=0;j<n;j++) diffs.push(x_exp[i]-x_ctl[j]);
  diffs.sort(function(a,b){return a-b;});
  var est = median(diffs);
  var mn = m*n;
  var k = _hl_trim(m, n, alpha);
  if (k >= Math.floor((mn+1)/2)) return [est, NAN, NAN];
  return [est, diffs[k], diffs[mn-1-k]];
}

// --------------------------------------------------------------------------
// Benjamini-Hochberg FDR
// --------------------------------------------------------------------------

function bh_fdr(pvals){
  var m = pvals.length;
  if (m === 0) return [];
  var order = pvals.map(function(_,i){return i;}).sort(function(a,b){return pvals[a]-pvals[b];});
  var q = new Array(m).fill(0.0);
  var prev = 1.0;
  for (var rank=m; rank>=1; rank--){
    var i = order[rank-1];
    var val = pvals[i]*m/rank;
    prev = Math.min(prev, val);
    q[i] = Math.min(1.0, prev);
  }
  return q;
}

function _mean_std(xs){
  var n = xs.length;
  var m = 0; for (var i=0;i<n;i++) m += xs[i]; m /= n;
  var vv = 0;
  if (n > 1){ for (var j=0;j<n;j++){ var d = xs[j]-m; vv += d*d; } vv /= (n-1); }
  return [m, Math.sqrt(vv)];
}

function _summ(xs){
  if (!xs.length) return {n:0, median:null, q1:null, q3:null, min:null, max:null, mean:null, std:null, vals:[]};
  var ms = _mean_std(xs);   // same mean/std computation as everywhere else
  return {n:xs.length, median:median(xs), q1:quantile(xs,0.25), q3:quantile(xs,0.75),
          min:Math.min.apply(null,xs), max:Math.max.apply(null,xs),
          mean:ms[0], std:ms[1], vals:xs.slice().sort(function(a,b){return a-b;})};
}
function _ranges_overlap(a, b){
  if (!a.length || !b.length) return false;
  return !(Math.max.apply(null,a) < Math.min.apply(null,b) || Math.max.apply(null,b) < Math.min.apply(null,a));
}

export { quantile, median, mann_whitney, hodges_lehmann, bh_fdr, erfc, _mean_std, _summ, _ranges_overlap };
