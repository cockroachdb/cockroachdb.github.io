// Copy text to the clipboard, with a hidden-textarea + execCommand fallback for browsers
// (or file://) where the async clipboard API is unavailable. Shared by the chart (copy a
// provenance cell) and the bootstrap (copy a share link) — one implementation.
export function copyText(t: string): Promise<void> {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
  return new Promise<void>(function (res, rej) {
    var ta = document.createElement("textarea");
    ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand("copy"); res(); } catch (err) { rej(err); }
    finally { document.body.removeChild(ta); }
  });
}
