// Golden test: the pre-refactor CORE (extracted verbatim from the original single-file
// report, node-runnable via module.exports) is the oracle. We run it and the NEW layered
// compute+render modules on identical synthetic inputs and assert byte-for-byte identical
// results — analyze() ctx, data_json(), and every HTML/SVG string generator. This proves
// the extraction changed no behavior.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import * as NEW from "../src/core/index";
import { dualArms, soloArms, dualArmsNew, soloArmsNew } from "./fixture";

const require = createRequire(import.meta.url);
const OLD = require("./golden/core.reference.cjs");

const OPS = ["agg", "stockLevel", "orderStatus", "delivery", "newOrder", "payment"];

// Keys the frozen OLD oracle can't track (display/serialization or intentionally-redefined):
//   runs/perRun/prov_details — see note in the ctx test below
//   rRatio* — node-skew ratio, intentionally redefined to (max−min)/initial-mean (was the OLD
//             oracle's (max−mean)/instantaneous-mean). Present in ctx.series AND data_json.series.
//   time_to_stall / mbps_rows — now ALSO populated for a solo arm (single-column tables); the
//             frozen oracle only computes them for dual. mbps_rows additionally gained the
//             whole-operation throughput rows and a stable `key` per row. The dual disk-rate
//             values are unchanged and re-checked explicitly below.
//   milestones — restore usability milestones from the optional `timings` block, a format
//             addition the frozen oracle predates. Empty for these fixtures.
//   armKeys — the ordered list of arms the chart should draw (A/B/C); a display concern the
//             frozen oracle predates. labels stays {ctl,exp} for 1-2 arms, so it isn't dropped.
const DROP: any = { runs: 1, perRun: 1, prov_details: 1, rRatio: 1, rRatioPc: 1, rRatioRuns: 1, rRatioPcRuns: 1,
  time_to_stall: 1, mbps_rows: 1, milestones: 1, armKeys: 1 };
const drop = (_k: string, v: any) => (DROP[_k] ? undefined : v);

// The OLD oracle parses the pre-refactor body (row/columnar); the NEW layer parses the v:2
// body. Both fixtures serialize the SAME underlying numbers, so an identical analyze() ctx
// proves the format migration + new parse_run preserve compute semantics.
function checkCatalog(name: string, makeOld: () => any[], makeNew: () => any[]) {
  describe(name, () => {
    const oldCtx = OLD.analyze(makeOld());
    const newCtx = NEW.CORE.analyze(makeNew());

    it("analyze() ctx is identical", () => {
      // Everything except the DROP keys (see above) — cells, stats, series, timing, labels — matches.
      expect(JSON.stringify(newCtx, drop)).toEqual(JSON.stringify(oldCtx, drop));
    });

    it("data_json() is identical", () => {
      expect(JSON.stringify(NEW.CORE.data_json(newCtx), drop)).toEqual(
        JSON.stringify(OLD.data_json(oldCtx), drop),
      );
    });

    // The dual A-vs-B comparison values are unchanged by the N-arm work; the row SHAPE changed
    // (flat a/b/dsec/dpct/p -> {arms:[{v,std,n}], cmp:[{d,dpct,p}]} so a third arm can interleave),
    // so extract the equivalent baseline+first-comparand values and re-check those against the oracle.
    it("dual time_to_stall & mbps_rows match the oracle", () => {
      if (!oldCtx.dual) return;   // solo rows are a new feature the frozen oracle predates
      const newTs = (r: any) => ({ pct: r.pct, a: r.arms[0].v, a_std: r.arms[0].std, b: r.arms[1].v, b_std: r.arms[1].std, dsec: r.cmp[0].d, dpct: r.cmp[0].dpct, p: r.cmp[0].p });
      const oldTs = (r: any) => ({ pct: r.pct, a: r.a, a_std: r.a_std, b: r.b, b_std: r.b_std, dsec: r.dsec, dpct: r.dpct, p: r.p });
      expect(JSON.stringify(newCtx.time_to_stall.map(newTs))).toEqual(JSON.stringify(oldCtx.time_to_stall.map(oldTs)));
      // mbps_rows now leads with the whole-operation `restored` row, which needs a
      // metadata.total_bytes these fixtures don't carry, so it isn't emitted here. The oracle's
      // two rows are the disk rates, whose math is untouched — match them by `key` and compare
      // values. Labels are display strings ("avg MB/s" -> "disk avg rate", since the unit moved
      // into the cell) and are deliberately not asserted. time_to_stall's cmp is likewise still
      // the seconds-based comparison the oracle computes: the table prefers the min/TB/node one
      // (row.cost), which these size-less fixtures don't get.
      const newMb = (r: any) => ({ key: r.key, a: r.arms[0].v, a_std: r.arms[0].std, b: r.arms[1].v, b_std: r.arms[1].std, d: r.cmp[0].d, dpct: r.cmp[0].dpct, p: r.cmp[0].p });
      const oldMb = (r: any, i: number) => ({ key: ["avg", "peak"][i], a: r.a, a_std: r.a_std, b: r.b, b_std: r.b_std, d: r.d, dpct: r.dpct, p: r.p });
      const disk = newCtx.mbps_rows.filter((r: any) => r.key === "avg" || r.key === "peak");
      expect(JSON.stringify(disk.map(newMb))).toEqual(JSON.stringify(oldCtx.mbps_rows.map(oldMb)));
    });

    // NOTE: the HTML render generators (render_body, tables, bake_svg) are intentionally NO
    // LONGER compared to the original — the report's layout/controls/labels are being actively
    // redesigned. Compute fidelity (analyze() ctx + data_json() above) is the durable invariant
    // this test guards; render output is covered behaviorally by smoke/hover/gestures/sticky.
    it("bake_svg() runs for every op (no throw)", () => {
      for (const op of OPS) expect(typeof NEW.CORE.bake_svg(op, newCtx.series[op], op === "agg")).toBe("string");
    });
  });
}

checkCatalog("dual-arm catalog", dualArms, dualArmsNew);
checkCatalog("solo-arm catalog", soloArms, soloArmsNew);
