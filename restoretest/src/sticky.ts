// Sticky dashboard behavior. The progress graph pins to the top and SMOOTHLY squishes to a
// compact strip as you scroll past it; the split-ribbon control bars pin just under it.
//
// This module drives the squish by scrubbing the graph's height from scroll position (keyed off
// a stable sentinel above the graph, with body scroll-anchoring disabled so the height change
// doesn't fight the scroll). It also publishes the graph's CURRENT height into --dash-graph-cur
// so the control bars (which pin at top:var(--dash-graph-cur)) ride the graph's shrinking bottom
// edge rather than disappearing behind it and reappearing once compact.
const COMPACT = 110; // px — the compact strip height
let dash: HTMLElement | null = null;
let graph: HTMLElement | null = null;
let fullH = 0; // measured natural graph height
let armH = 0; // measured arm-bar height (0 when there's no bar)
let pinStart = 0; // scrollY at which the graph reaches the top and starts squishing
let ticking = false;

function measure() {
  dash = document.querySelector(".dash") as HTMLElement | null;
  if (!dash) return;
  graph = document.querySelector(".stick-graph") as HTMLElement | null;
  const sentinel = document.querySelector(".stick-sentinel") as HTMLElement | null;
  // The arm bar pins to the top (top:0) across the whole scroll; the graph and control bars pin
  // just beneath it via top:calc(var(--dash-arm-h) + ...). Publish the bar's height so they stack
  // under it rather than behind it (0 when there's no bar — a single-arm report).
  const arm = document.querySelector(".armbar") as HTMLElement | null;
  armH = arm ? arm.getBoundingClientRect().height : 0;
  dash.style.setProperty("--dash-arm-h", armH.toFixed(1) + "px");
  if (graph && sentinel) {
    graph.style.height = "";          // reset to natural to measure the full height
    graph.classList.remove("stuck");
    fullH = graph.getBoundingClientRect().height;
    // The graph pins at top:armH (just under the arm bar). The sentinel sits just above the graph
    // and is NOT sticky, so its document position is stable regardless of the graph's height —
    // measure the squish threshold from it, offset by armH since the graph pins that much higher.
    pinStart = sentinel.getBoundingClientRect().top + window.scrollY - armH;
  }
  apply();
}

function apply() {
  if (!graph || !dash) return;
  const range = Math.max(1, fullH - COMPACT);
  const t = Math.max(0, Math.min(1, (window.scrollY - pinStart) / range)); // 0 (full) .. 1 (compact)
  const h = fullH - t * range;
  if (t <= 0) {
    graph.style.height = "";
    graph.classList.remove("stuck");
  } else {
    graph.style.height = h.toFixed(1) + "px";
    graph.classList.add("stuck"); // squish the SVG + drop axis text/grid while collapsing
  }
  // Publish the graph's current bottom so the control bars sit right under it as it shrinks.
  dash.style.setProperty("--dash-graph-cur", h.toFixed(1) + "px");
}

function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { ticking = false; apply(); });
}

export function initSticky() {
  measure();
}

if (typeof window !== "undefined") {
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", measure);
}
