// ---------------------------------------------------------------------------
// Recently-viewed run sets: a browser-local (IndexedDB) history of every run set the report
// has shown, surfaced by the ribbon's [+ recently viewed] tile so a previously-seen set can be
// re-added without re-finding its link.
//
// A run set's identity is test + timestamp + arm — the SAME key runsets.ts groups by (imported
// as setIdentity), so a stored set's id equals its runs' identity and re-adding round-trips.
//
// Storage is split so the modal listing never touches heavy run bodies and never re-derives the
// per-card stats (e.g. avg time-to-100%):
//   - store `cards`  : one light, precomputed card per set (metadata + runCount + avgTo100).
//   - store `bodies` : the raw v:2 run bodies, read only when a card is actually added.
// Everything IDB is best-effort: a missing/blocked store (e.g. file://, private mode) degrades
// to "no history" rather than throwing, so the report keeps working.
// ---------------------------------------------------------------------------
import { esc, fmtDur, fmtSettings } from "../format/format";
import { setIdentity } from "./runsets";

export { setIdentity };   // re-exported so callers/tests get identity + helpers from one place

// ---- pure helpers (no DOM, no IDB) — unit-tested directly ------------------

var MON = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

// Average time (seconds) for a set's runs to reach 100% download: per run, the first `elapsed`
// where `download.pct` >= 100, averaged; null if no run ever reaches it. Same semantics as
// crossings_elapsed[100] in compute/series.ts, but computed straight off the raw v:2 body so
// the card is self-contained.
export function avgTimeTo100(runs){
  var els = [];
  (runs || []).forEach(function(r){
    var el = r && r.elapsed, dl = r && r.download, pct = dl && dl.pct;
    if (!Array.isArray(el) || !Array.isArray(pct)) return;
    for (var i = 0; i < el.length && i < pct.length; i++){
      if (pct[i] != null && pct[i] >= 100){ els.push(el[i]); break; }
    }
  });
  if (!els.length) return null;
  var sum = 0; els.forEach(function(v){ sum += v; });
  return sum / els.length;
}

// Project a run set (Arm object) to the light card the modal renders. `day` = yymmdd for the
// per-day grouping; avgTo100/runCount are precomputed here so the modal never re-derives them.
export function cardFromSet(set){
  var ts = (set && set.ts) || "";
  return {
    id: setIdentity(set),
    test: (set && set.test) || null,
    testLeaf: (String((set && set.test) || "").split("/").filter(Boolean).pop()) || null,
    ts: ts || null,
    arm: (set && set.ab) || null,
    version: (set && set.version) || null,
    buildTime: (set && set.buildTime) || null,
    commit: (set && set.commit) || null,
    branch: (set && set.branch) || null,
    settings: (set && set.settings) || {},
    runCount: ((set && set.runs) || []).length,
    avgTo100: avgTimeTo100((set && set.runs) || []),
    day: ts ? ts.slice(0, 6) : null,
  };
}

function cmp(a, b){ a = a || ""; b = b || ""; return a < b ? -1 : a > b ? 1 : 0; }
function dayLabel(day){
  var m = /^(\d{2})(\d{2})(\d{2})$/.exec(day || "");
  if (!m) return day || "";
  return (MON[(+m[2]) - 1] || ("M" + m[2])) + " " + m[3] + ", 20" + m[1];
}

// Sort cards newest-first by run time (timestamp is yymmdd-HHMMSS so a reverse string compare is
// reverse-chronological), tie-broken by test then arm; nest as test -> day for the modal's
// headers. First-appearance order of the sorted list fixes group order, so a test/day/item is
// ordered by its newest run — most recent at the top.
export function sortAndGroupCards(cards){
  var sorted = (cards || []).slice().sort(function(a, b){
    return cmp(b.ts, a.ts) || cmp(a.test, b.test) || cmp(a.arm, b.arm);
  });
  var groups = [], byTest = {};
  sorted.forEach(function(c){
    var tk = c.test || "";
    var g = byTest[tk];
    if (!g){ g = byTest[tk] = { test: c.test, testLeaf: c.testLeaf, days: [], _byDay: {} }; groups.push(g); }
    var dk = c.day || "";
    var d = g._byDay[dk];
    if (!d){ d = g._byDay[dk] = { day: c.day, dayLabel: dayLabel(c.day), items: [] }; g.days.push(d); }
    d.items.push(c);
  });
  groups.forEach(function(g){ delete g._byDay; });
  return groups;
}

// Render the modal body from grouped cards. Each set is a two-line card: "time · ARM · N× ·
// dur · settings" over "version – commit". Group headers show the FULL test name; a rule closes
// each day group. Addable rows carry the `+` icon and a data-rvadd attribute (id URL-encoded so
// the 0x1F identity separator stays attribute-safe); rows already in the catalog (`presentIds`)
// show a ✓ and are inert.
export function historyModalHTML(groups, presentIds){
  var present = presentIds || new Set();
  var has = function(id){ return present.has ? present.has(id) : false; };
  if (!groups || !groups.length){
    return "<p class='rvempty'>No run sets viewed yet — import a report and it'll show up here.</p>";
  }
  return groups.map(function(g){
    var days = g.days.map(function(d){
      var items = d.items.map(function(c){
        var have = has(c.id);
        var hm = c.ts ? (c.ts.slice(7, 9) + ":" + c.ts.slice(9, 11)) : "";
        var arm = c.arm ? (" · " + String(c.arm).toUpperCase()) : "";
        var dur = c.avgTo100 != null ? fmtDur(c.avgTo100) : "";
        var st = fmtSettings(c.settings);
        // line 1: time · ARM, then the quick stats — run count · duration · settings.
        var meta = [c.runCount + "×"];
        if (dur) meta.push(dur);
        if (st) meta.push(st);
        // line 2: version (12 chars) – commit subject (30 chars).
        var ver = c.version ? String(c.version).slice(0, 12) : "";
        var cm = c.commit ? String(c.commit).slice(0, 30) : "";
        var l2 = (ver ? "<span class=\"rvver\">" + esc(ver) + "</span>" : "")
          + (ver && cm ? " <span class=\"rvdash\">–</span> " : "")
          + (cm ? "<span class=\"rvcommit\">" + esc(cm) + "</span>" : "");
        var attr = have ? "" : (" data-rvadd=\"" + encodeURIComponent(c.id) + "\"");
        return "<div class=\"rvitem" + (have ? " rvhad" : "") + "\"" + attr + ">"
          + "<span class=\"rvicon\">" + (have ? "✓" : "+") + "</span>"
          + "<span class=\"rvcard\">"
          +   "<span class=\"rvl1\"><span class=\"rvtime\">" + esc(hm + arm) + "</span>"
          +     " <span class=\"rvmeta\">· " + esc(meta.join(" · ")) + "</span></span>"
          +   (l2 ? "<span class=\"rvl2\">" + l2 + "</span>" : "")
          + "</span>"
          + "</div>";
      }).join("");
      return "<div class=\"rvday\"><span>" + esc(d.dayLabel) + "</span>"
        + "<button class=\"rvdelday\" data-rvdelday=\"" + encodeURIComponent(d.day||"")
        + "\" data-rvdeltest=\"" + encodeURIComponent(g.test||"")
        + "\" title=\"remove this day's run sets from history\">×</button></div>"
        + items + "<hr class=\"rvhr\">";
    }).join("");
    return "<div class=\"rvgroup\"><div class=\"rvtest\">" + esc(g.test || g.testLeaf || "?") + "</div>" + days + "</div>";
  }).join("");
}

// ---- IndexedDB layer (best-effort) ----------------------------------------

var DB_NAME = "rt-history", DB_VER = 1, CAP = 50;

function openDB(): Promise<any>{
  return new Promise(function(resolve){
    try{
      if (typeof indexedDB === "undefined" || !indexedDB){ resolve(null); return; }
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function(){
        var db = req.result;
        if (!db.objectStoreNames.contains("cards")) db.createObjectStore("cards", { keyPath: "id" });
        if (!db.objectStoreNames.contains("bodies")) db.createObjectStore("bodies", { keyPath: "id" });
      };
      req.onsuccess = function(){ resolve(req.result); };
      req.onerror = function(){ resolve(null); };      // treat any open failure as "no history"
      req.onblocked = function(){ resolve(null); };
    } catch(e){ resolve(null); }
  });
}
function reqP(r): Promise<any>{
  return new Promise(function(res, rej){ r.onsuccess = function(){ res(r.result); }; r.onerror = function(){ rej(r.error); }; });
}
function txDone(tx): Promise<void>{
  return new Promise(function(res, rej){ tx.oncomplete = function(){ res(); }; tx.onerror = function(){ rej(tx.error); }; tx.onabort = function(){ rej(tx.error); }; });
}

// Upsert every current set (card + body), stamping lastViewed=now, then evict the oldest beyond
// CAP. Covers "on load, add any current set not yet stored" and keeps recency fresh. No-op on
// any failure.
export async function recordSets(sets){
  try{
    var db = await openDB(); if (!db) return;
    var now = Date.now();
    var tx = db.transaction(["cards", "bodies"], "readwrite");
    var cardStore = tx.objectStore("cards"), bodyStore = tx.objectStore("bodies");
    (sets || []).forEach(function(set){
      var id = setIdentity(set); if (!id) return;
      if (!(set && (set.test || set.ts))) return;   // skip metadata-less junk (renders as "? Nx")
      var card: any = cardFromSet(set); card.lastViewed = now;
      cardStore.put(card);
      bodyStore.put({ id: id, runs: (set && set.runs) || [] });
    });
    await txDone(tx);
    await evictOld(db);
    db.close();
  } catch(e){ /* best-effort */ }
}
async function evictOld(db){
  var tx = db.transaction("cards", "readonly");
  var cards = await reqP(tx.objectStore("cards").getAll());
  if (!cards || cards.length <= CAP) return;
  cards.sort(function(a, b){ return (b.lastViewed || 0) - (a.lastViewed || 0); });
  var doomed = cards.slice(CAP).map(function(c){ return c.id; });
  var tx2 = db.transaction(["cards", "bodies"], "readwrite");
  doomed.forEach(function(id){ tx2.objectStore("cards").delete(id); tx2.objectStore("bodies").delete(id); });
  await txDone(tx2);
}

// The light cards for the modal listing (never loads run bodies). [] on any failure. Also prunes
// any metadata-less junk cards (no test AND no ts — they render as "? Nx") left by older builds.
export async function listCards(){
  try{
    var db = await openDB(); if (!db) return [];
    var cards = await reqP(db.transaction("cards", "readonly").objectStore("cards").getAll()) || [];
    var junk = cards.filter(function(c){ return !(c && (c.test || c.ts)); });
    var good = cards.filter(function(c){ return c && (c.test || c.ts); });
    if (junk.length){
      var tx2 = db.transaction(["cards", "bodies"], "readwrite");
      junk.forEach(function(c){ tx2.objectStore("cards").delete(c.id); tx2.objectStore("bodies").delete(c.id); });
      await txDone(tx2);
      console.log("[import] pruned " + junk.length + " junk history card(s)");
    }
    db.close();
    return good;
  } catch(e){ return []; }
}

// Delete the given set ids (card + body) from history. No-op on any failure.
export async function deleteSets(ids){
  try{
    var db = await openDB(); if (!db) return;
    var tx = db.transaction(["cards", "bodies"], "readwrite");
    (ids || []).forEach(function(id){ tx.objectStore("cards").delete(id); tx.objectStore("bodies").delete(id); });
    await txDone(tx);
    db.close();
  } catch(e){ /* best-effort */ }
}

// Raw runs for the given set ids (clicked card + its sibling arms), concatenated. All gets are
// issued into one transaction before awaiting so it doesn't auto-close between reads. [] on
// failure.
export async function getRunsFor(ids){
  try{
    var db = await openDB(); if (!db) return [];
    var tx = db.transaction("bodies", "readonly"), store = tx.objectStore("bodies");
    var results = await Promise.all((ids || []).map(function(id){ return reqP(store.get(id)); }));
    db.close();
    var out = [];
    results.forEach(function(b){ if (b && b.runs) out = out.concat(b.runs); });
    return out;
  } catch(e){ return []; }
}
