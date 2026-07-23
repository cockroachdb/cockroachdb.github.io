// Linear interpolation over sorted point arrays.

function _interp(pts, xq){
  if (!pts.length || xq < pts[0][0] || xq > pts[pts.length-1][0]) return null;
  var lo = 0, hi = pts.length-1;
  while (lo < hi){
    var mid = (lo+hi)>>1;
    if (pts[mid][0] < xq) lo = mid+1; else hi = mid;
  }
  if (pts[lo][0] === xq || lo === 0) return pts[lo][1];
  var x0=pts[lo-1][0], y0=pts[lo-1][1], x1=pts[lo][0], y1=pts[lo][1];
  if (x1 === x0) return y1;
  return y0 + (y1-y0)*(xq-x0)/(x1-x0);
}

function _iXY(arr, t){ // arr: [{x,y}] sorted by x
  if (!arr || !arr.length || t < arr[0].x || t > arr[arr.length-1].x) return null;
  for (var i=1;i<arr.length;i++){ if (arr[i].x >= t){ var a=arr[i-1], b=arr[i];
    return b.x===a.x ? b.y : a.y + (b.y-a.y)*(t-a.x)/(b.x-a.x); } }
  return arr[arr.length-1].y;
}

// Inverse of _iXY: the x (elapsed) at which a [{x,y}] curve first reaches y >= pc, linearly
// interpolated. Used to find the elapsed at a download-% crossing (download tables + chart).
function _dlCrossT(dc, pc){ if (!dc || !dc.length) return null;
  for (var i=0;i<dc.length;i++){ if (dc[i].y >= pc){ if (i===0) return dc[0].x; var a=dc[i-1], b=dc[i];
    return b.y===a.y ? b.x : a.x + (b.x-a.x)*(pc-a.y)/(b.y-a.y); } } return null; }

export { _interp, _iXY, _dlCrossT };
