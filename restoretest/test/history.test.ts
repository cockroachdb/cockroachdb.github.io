// Unit tests for the recently-viewed history's PURE helpers (no IndexedDB): identity keying,
// avg time-to-100%, card projection, sort+group (test -> run time -> arm; grouped test -> day),
// and the modal HTML's +/✓ marking. The IDB wrapper stays a thin pass-through and isn't
// exercised here (no IDB in the node test env).
import { describe, it, expect } from "vitest";
import { avgTimeTo100, cardFromSet, sortAndGroupCards, historyModalHTML, setIdentity } from "../src/app/history";
import { identityKey } from "../src/app/runsets";
import { fmtSettings } from "../src/format/format";

function run(elapsed: number[], pct: (number | null)[]) {
  return { v: 2, elapsed, download: { pct, mbps: [], node_remote_mb: [] }, ops: {} };
}
function set(over: any) {
  return Object.assign(
    { test: "t", ts: "260101-000000", ab: null, version: null, buildTime: null,
      commit: null, branch: null, settings: {}, runs: [] },
    over
  );
}

describe("avgTimeTo100", () => {
  it("averages the first elapsed where pct>=100 across runs", () => {
    // crossings at 60 and 60 -> 60
    expect(avgTimeTo100([run([0, 30, 60, 90], [0, 50, 100, 100]),
                         run([0, 30, 60], [0, 80, 100])])).toBe(60);
    // crossings at 30 and 90 -> 60
    expect(avgTimeTo100([run([0, 30], [0, 100]),
                         run([0, 30, 60, 90], [0, 40, 70, 100])])).toBe(60);
  });
  it("returns null when no run ever reaches 100%", () => {
    expect(avgTimeTo100([run([0, 30], [0, 80])])).toBe(null);
  });
  it("skips runs missing elapsed/pct and averages the rest", () => {
    expect(avgTimeTo100([run([0, 30], [0, 100]), { elapsed: null, download: null } as any])).toBe(30);
  });
});

describe("setIdentity", () => {
  it("matches the runsets grouping key for the same identity triple", () => {
    const s = set({ test: "t", ts: "260101-000000", ab: "b" });
    expect(setIdentity(s)).toBe(identityKey({ test: "t", timestamp: "260101-000000", arm: "b" }));
  });
});

describe("cardFromSet", () => {
  it("projects id, testLeaf, day, arm, runCount, avgTo100 and provenance", () => {
    const s = set({
      test: "restore/nodes=8/cpus=8", ts: "260722-164502", ab: "a",
      version: "abc-dirty", buildTime: "2026/07/20 12:00:00", commit: "subj", branch: "master",
      runs: [run([0, 30, 60], [0, 50, 100])],
    });
    const c = cardFromSet(s);
    expect(c.id).toBe(setIdentity(s));
    expect(c.testLeaf).toBe("cpus=8");
    expect(c.day).toBe("260722");
    expect(c.arm).toBe("a");
    expect(c.version).toBe("abc-dirty");
    expect(c.buildTime).toBe("2026/07/20 12:00:00");
    expect(c.runCount).toBe(1);
    expect(c.avgTo100).toBe(60);
  });
});

describe("sortAndGroupCards", () => {
  it("sorts newest-first (test/day/item by recency); groups by test then day", () => {
    const cards = [
      cardFromSet(set({ test: "B", ts: "260102-100000" })),
      cardFromSet(set({ test: "A", ts: "260101-120000", ab: "b" })),
      cardFromSet(set({ test: "A", ts: "260101-120000", ab: "a" })),
      cardFromSet(set({ test: "A", ts: "260101-090000" })),
      cardFromSet(set({ test: "A", ts: "260103-080000" })),
    ];
    const g = sortAndGroupCards(cards);
    expect(g.map((x) => x.test)).toEqual(["A", "B"]); // A owns the newest run (260103)

    const A = g[0];
    expect(A.days.map((d) => d.day)).toEqual(["260103", "260101"]); // newest day first
    expect(A.days[1].items.map((i) => [i.ts, i.arm])).toEqual([
      ["260101-120000", "a"], // within a day, newest first (a/b share the newest ts)
      ["260101-120000", "b"],
      ["260101-090000", null],
    ]);
    expect(g[1].days[0].day).toBe("260102");
  });
});

describe("fmtSettings", () => {
  it("drops .enabled, strips vowels from the key, and abbreviates the value", () => {
    expect(fmtSettings({ "kv.range_split.by_load.enabled": "true" })).toBe("kv.rng_splt.by_ld=t");
    expect(fmtSettings({ "kv.range_split.by_load.enabled": "false" })).toBe("kv.rng_splt.by_ld=f");
  });
  it("keeps non-boolean values as-is and space-joins multiple settings", () => {
    expect(fmtSettings({ "cluster.organization": "Cockroach Labs", "kv.gc.ttl": "25" }))
      .toBe("clstr.rgnztn=Cockroach Labs kv.gc.ttl=25");
  });
  it("returns empty string for no settings", () => {
    expect(fmtSettings({})).toBe("");
    expect(fmtSettings(null)).toBe("");
  });
});

describe("historyModalHTML", () => {
  it("marks present ids with ✓ (inert) and absent ids with + data-rvadd (encoded)", () => {
    const s1 = set({ test: "t", ts: "260101-000000", ab: "a" });
    const s2 = set({ test: "t", ts: "260101-000000", ab: "b" });
    const groups = sortAndGroupCards([cardFromSet(s1), cardFromSet(s2)]);
    const html = historyModalHTML(groups, new Set([setIdentity(s1)]));
    expect(html).toContain("✓");
    // the absent set carries an (encoded) data-rvadd; the present one does not
    expect(html).toContain('data-rvadd="' + encodeURIComponent(setIdentity(s2)) + '"');
    expect(html).not.toContain('data-rvadd="' + encodeURIComponent(setIdentity(s1)) + '"');
  });
  it("shows an empty message when there are no groups", () => {
    expect(historyModalHTML([], new Set())).toContain("No run sets viewed yet");
  });
});
