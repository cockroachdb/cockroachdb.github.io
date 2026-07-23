// Unit test for the run-set grouping: identity = test + timestamp + arm, provenance parsed
// from metadata (sha/dirty/buildTime from version), first-appearance order sets A/B roles,
// and catalogToRuns round-trips.
import { describe, it, expect } from "vitest";
import { runsToSets, catalogToRuns } from "../src/app/runsets";
import { dualRuns } from "./fixture";

function run(meta: any) {
  return { v: 2, metadata: meta, elapsed: [0, 30], download: { pct: [0, 100], mbps: [0, 50], node_remote_mb: [] }, ops: {} };
}
const V = (sha: string, dirty = false) => `${sha}${dirty ? "-dirty" : ""}`;   // short build id

describe("runsToSets", () => {
  it("groups by test + timestamp + arm, preserving first-appearance order", () => {
    const runs = [
      run({ test: "t", timestamp: "260101-000000", version: V("aaa111") }),
      run({ test: "t", timestamp: "260101-000000", version: V("aaa111") }),
      run({ test: "t", timestamp: "260102-000000", version: V("bbb222") }),
    ];
    const sets = runsToSets(runs);
    expect(sets.length).toBe(2);
    expect(sets[0].runs.length).toBe(2); // two repetitions of the first invocation
    expect(sets[1].runs.length).toBe(1);
    expect(sets[0].ts).toBe("260101-000000");
    expect(sets[1].ts).toBe("260102-000000");
  });

  it("splits one timestamp into two sets by the arm field (A/B in one invocation)", () => {
    const runs = [
      run({ test: "t", timestamp: "260101-000000", version: V("aaa111"), arm: "a" }),
      run({ test: "t", timestamp: "260101-000000", version: V("aaa111"), arm: "b" }),
      run({ test: "t", timestamp: "260101-000000", version: V("aaa111"), arm: "a" }),
    ];
    const sets = runsToSets(runs);
    expect(sets.length).toBe(2);
    expect(sets.map((s) => s.ab)).toEqual(["a", "b"]);
    expect(sets[0].runs.length).toBe(2);
    expect(sets[1].runs.length).toBe(1);
  });

  it("carries version as-is + built + commit/branch onto the set", () => {
    const [s] = runsToSets([
      run({ test: "t", timestamp: "260101-000000", version: "deadbeef00-dirty",
            built: "2026/07/14 20:44:44", commit: "subject", branch: "feat" }),
    ]);
    expect(s.version).toBe("deadbeef00-dirty");   // shown verbatim, no -dirty special-casing
    expect(s.buildTime).toBe("2026/07/14 20:44:44");
    expect(s.commit).toBe("subject");
    expect(s.branch).toBe("feat");
  });

  it("round-trips through catalogToRuns (flatten -> regroup keeps sets and order)", () => {
    const sets = runsToSets(dualRuns());
    expect(sets.length).toBe(2);
    const regrouped = runsToSets(catalogToRuns(sets));
    expect(regrouped.map((s) => [s.ts, s.ab, s.runs.length]))
      .toEqual(sets.map((s) => [s.ts, s.ab, s.runs.length]));
  });
});
