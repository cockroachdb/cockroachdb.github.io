// Port of the original CORE self_test() into vitest cases. These are oracle-independent
// unit guards (specific MWU/HL/BH/interp/agg/series values), complementing golden.test.ts.
import { describe, it, expect } from "vitest";
import { LK } from "../src/model/constants";
import { quantile, median, mann_whitney, hodges_lehmann, bh_fdr } from "../src/compute/stats";
import { _interp } from "../src/compute/interp";
import { qps_weighted_agg } from "../src/compute/ingest";
import { crossing_sample, resample, download_curve, crossings_elapsed, build_series } from "../src/compute/series";

const approx = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

describe("self_test (ported)", () => {
  it("median / quantile", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(approx(quantile([1, 2, 3, 4], 0.25), 1.75)).toBe(true);
    expect(approx(quantile([1, 2, 3, 4], 0.75), 3.25)).toBe(true);
  });

  it("Mann-Whitney U (exact + normal branches, ties)", () => {
    const mw = mann_whitney([1, 2, 3], [4, 5, 6]);
    expect(mw[2]).toBe("exact");
    expect(approx(mw[1] as number, 0.1)).toBe(true);
    expect(approx(mw[0] as number, 0.0)).toBe(true);
    expect(approx(mann_whitney([1, 2, 3, 4], [5, 6, 7, 8])[1] as number, 2.0 / 70.0)).toBe(true);
    expect(approx(mann_whitney([1, 2], [2, 3])[1] as number, 2.0 / 3.0)).toBe(true);
    expect(approx(mann_whitney([5, 5, 5], [5, 5, 5])[1] as number, 1.0)).toBe(true);
    const rng = (a: number, b: number) => { const o = []; for (let i = a; i < b; i++) o.push(i); return o; };
    const mwb = mann_whitney(rng(1, 15), rng(15, 29));
    expect(mwb[2]).toBe("normal");
    expect((mwb[1] as number) < 0.001).toBe(true);
  });

  it("Hodges-Lehmann", () => {
    expect(approx(hodges_lehmann([3, 4], [1, 2])[0], 2.0)).toBe(true);
    expect(approx(hodges_lehmann([11, 12, 13, 14], [1, 2, 3, 4])[0], 10.0)).toBe(true);
  });

  it("Benjamini-Hochberg FDR", () => {
    const q = bh_fdr([0.005, 0.011, 0.02, 0.04, 0.13]);
    expect(approx(q[0], 0.025)).toBe(true);
    expect(approx(q[4], 0.13)).toBe(true);
  });

  it("interpolation", () => {
    const pts: [number, number][] = [[0.0, 10.0], [10.0, 20.0], [20.0, 40.0]];
    expect(_interp(pts, 10.0)).toBe(20.0);
    expect(approx(_interp(pts, 5.0)!, 15.0)).toBe(true);
    expect(approx(_interp(pts, 15.0)!, 30.0)).toBe(true);
    expect(_interp(pts, -1.0)).toBe(null);
    expect(_interp(pts, 21.0)).toBe(null);
    expect(_interp([[3.0, 7.0]], 3.0)).toBe(7.0);
  });

  it("qps-weighted agg", () => {
    const lat: Record<string, number> = {};
    lat[LK("a", "p50")] = 10.0; lat[LK("a", "p95")] = 20.0; lat[LK("a", "p99")] = 30.0;
    lat[LK("b", "p50")] = 100.0; lat[LK("b", "p95")] = 200.0; lat[LK("b", "p99")] = 300.0;
    const agg = qps_weighted_agg(lat, { a: 3.0, b: 1.0 });
    expect(approx(agg.qps, 4.0)).toBe(true);
    expect(approx(agg.p50, (3 * 10 + 1 * 100) / 4.0)).toBe(true);
    expect(qps_weighted_agg(lat, { a: 0.0 })).toBe(null);
  });

  it("crossings / resample / download_curve / build_series", () => {
    const mkS = (el: number, pct: number, p50: number) => {
      const L: Record<string, number> = {}; L[LK("agg", "p50")] = p50;
      return { el, pct, lat: L, qps: {}, ctx: {} };
    };
    const run = [mkS(0.0, 0.0, 100.0), mkS(30.0, 0.5, 60.0), mkS(60.0, 1.0, 20.0)];
    expect(crossing_sample(run, 60)!.el).toBe(60.0);
    expect(crossing_sample(run, 30)!.el).toBe(30.0);
    expect(crossing_sample(run, 0)!.el).toBe(0.0);
    const rs = resample([run], "agg", "p50", "el", [0, 30, 60]);
    expect(rs.every((p: any) => p.n === 1)).toBe(true);
    expect(rs.every((p: any) => p.s === 0.0)).toBe(true);
    expect(rs.map((p: any) => p.m)).toEqual([100.0, 60.0, 20.0]);
    const rs2 = resample([run, run], "agg", "p50", "el", [30]);
    expect(rs2[0].n === 2 && rs2[0].s === 0.0).toBe(true);
    expect(download_curve([run], [0, 30, 60]).map((p: any) => p.y)).toEqual([0.0, 50.0, 100.0]);
    expect(crossings_elapsed([run])[60]).toBe(60.0);
    const bs = build_series("agg", [run], [], false, [0, 30, 60], [0, 50, 100]);
    const pc = bs.pc["ctl_p50"];
    expect(pc.every((p: any) => "e" in p)).toBe(true);
    expect(pc.filter((p: any) => p.x === 50)[0].e).toBe(30.0);
  });
});
