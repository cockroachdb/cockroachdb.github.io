// The CORE export surface, reassembled from the layered modules. In the original
// single-file report this was one IIFE; consumers now import the functions directly
// (bootstrap: analyze / render_body; chart: the table generators). The `CORE` object is
// kept as a convenience barrel (the test suite drives it) and mirrors the original export
// list, minus generators the redesigned report no longer renders.
import { OPS, LAT_METRICS, STALLS, STALL_PCT, LK } from "../model/constants";
import { pyRound } from "../util";
import { quantile, median, mann_whitney, hodges_lehmann, bh_fdr, erfc } from "../compute/stats";
import { qps_weighted_agg, parse_run } from "../compute/ingest";
import { _interp } from "../compute/interp";
import { crossing_sample, _xy, resample, download_curve, crossings_elapsed, build_series } from "../compute/series";
import { build_cells, compute_cell_stats, qps_median, is_primary } from "../compute/cells";
import { analyze, data_json, time_rows } from "../compute/analyze";
import { bake_svg } from "../render/svg";
import { op_time_table, time_to_stall_table, mbps_table } from "../render/tables";
import { render_body } from "../render/body";

// Mirrors the original CORE object literal (self_test lives in the vitest suite now).
const CORE = {
  OPS, LAT_METRICS, STALLS, STALL_PCT,
  LK, pyRound, quantile, median, mann_whitney,
  hodges_lehmann, bh_fdr, erfc,
  qps_weighted_agg, parse_run,
  crossing_sample, _xy, _interp, resample,
  download_curve, crossings_elapsed, build_series,
  build_cells, compute_cell_stats, qps_median,
  is_primary, analyze, data_json, render_body,
  bake_svg, op_time_table, time_rows,
  time_to_stall_table, mbps_table,
};

export { CORE };
export default CORE;

export { analyze, data_json, time_rows } from "../compute/analyze";
export { render_body } from "../render/body";
