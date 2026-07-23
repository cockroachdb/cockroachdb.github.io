// Run sets: group a flat list of runs (each a v:2 summary_report.json carrying a `metadata`
// block) into the arm objects analyze() consumes. Identity — the grouping key — is
// test + timestamp + arm (arm treated as "" when absent):
//   - no arm            -> one invocation = one set
//   - arm "a"/"b" sharing a timestamp -> that invocation splits into two sets
//   - different timestamps -> separate sets
// Everything else in metadata (version -> sha/dirty/buildTime, settings, commit, branch) is
// display/provenance, not keyed. First-appearance order is preserved, so it sets the A/B
// color roles (set 1 -> control, set 2 -> experiment). See summary_report_spec.md.

export var GROUP_SEP ="";   // unit separator (0x1F) — can't appear in the keyed strings. Exported for history.ts.

// Identity of a run from its metadata block. See summary_report_spec.md §2.
export function identityKey(m){
  return [(m && m.test) || "", (m && m.timestamp) || "", (m && m.arm) || ""].join(GROUP_SEP);
}

// Identity of a run SET (Arm object): same triple, sourced from the set's derived fields so a
// set's id matches its runs' identityKey. `test`/`ts`/`ab` are set by setToArm() below.
export function setIdentity(set){
  return [(set && set.test) || "", (set && set.ts) || "", (set && set.ab) || ""].join(GROUP_SEP);
}

// Build the arm object (run set) analyze()/the picker consume from a group's metadata + runs.
// `version` is a short build id the generator already shaped (tag / sha / sha-dirty); the
// report shows it as-is. `built` carries the build time. See summary_report_spec.md.
function setToArm(meta, runs){
  var handle = meta.timestamp ? (meta.timestamp + (meta.arm ? ("-" + meta.arm) : "")) : null;
  var testLeaf = (String(meta.test || "").split("/").filter(Boolean).pop()) || null;
  return {
    label: null,                          // filled by labelArms() at selection time
    name: handle || testLeaf || "run",
    ts: meta.timestamp || null,
    ab: meta.arm || null,
    version: meta.version || null,        // shown as-is in provenance
    settings: meta.settings || {},
    buildTime: meta.built || null,
    test: meta.test || null,
    commit: meta.commit || null,
    branch: meta.branch || null,
    runs: runs,
  };
}

// Group runs -> arm objects, preserving first-appearance order of the identity key.
export function runsToSets(runs){
  var order = [], byKey = {};
  (runs || []).forEach(function(run){
    var m = (run && run.metadata) || {};
    var key = identityKey(m);
    var g = byKey[key];
    if (!g){ g = byKey[key] = { meta: m, runs: [] }; order.push(key); }
    g.runs.push(run);
  });
  return order.map(function(key){ var g = byKey[key]; return setToArm(g.meta, g.runs); });
}

// Flatten a catalog of arm objects back to the flat run list, in catalog order — the inverse
// of runsToSets for persistence/upload (regrouping on load reconstructs the same sets, in the
// same order, so persisted `sel` indices stay valid).
export function catalogToRuns(catalog){
  var out = [];
  (catalog || []).forEach(function(a){ (a && a.runs || []).forEach(function(r){ out.push(r); }); });
  return out;
}
