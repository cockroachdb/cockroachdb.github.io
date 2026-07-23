# summary_report.json + report-link (slug) spec

The online-restore perf report is driven entirely by a set of **runs**. Each run is one
`summary_report.json`. The generator (the roachtest) emits these files and can build a
shareable report URL by inlining them in the URL fragment. The report UI groups runs into
**run sets** by identity and renders them.

There is one body format (`v: 2`); there is no row-format or legacy path from the generator.

---

## 1. Per-run object (`summary_report.json`)

```jsonc
{
  "v": 2,                              // REQUIRED format marker

  "metadata": {
    "test":      "restore/online/perf-breakdown/full-only/.../nodes=8/cpus=8",
    "timestamp": "260714-204440",      // yymmdd-HHMMSS — the INVOCATION time; identical for
                                       //   every run of the same set
    "version":   "abcdef0123456789",   // SHORT build id: tag / sha / sha-dirty (see below)
    "built":     "2026/07/14 20:44:44",// OPTIONAL build time, display-only (any string)
    "settings":  { "kv.x": "1" },      // --set overrides; {} if none
    "arm":       "a",                  // OPTIONAL — only when ONE invocation emits an A/B pair
                                       //   sharing timestamp; "a"/"b"
    "commit":    "cloud: record network bytes…",  // OPTIONAL provenance (commit subject)
    "branch":    "master"              // OPTIONAL provenance
  },

  "elapsed": [0, 30, 60, 90, …],       // seconds, ascending, unique — THE time axis.
                                       //   Every value array below is exactly this length.

  "download": {                        // run-global, download domain
    "pct":  [ … ],                     //   download %  (0.1% resolution)
    "mbps": [ … ],                     //   MB/s (already per-node)
    "node_remote_mb": [                //   per-node MB still to download — one array per node
      [ … ],                           //     node 0
      [ … ]                            //     node 1, …
    ]
  },

  "ops": {                             // per-op workload latency — REAL ops only
    "<op>": { "qps": […], "p50": […], "p95": […], "p99": […] }   // p50/p95/p99 in whole ms
  }
}
```

### Body rules

- **One sample clock.** Record every metric each tick, so there is a single `elapsed` axis.
- **Alignment.** Every value array — `download.pct`, `download.mbps`, each `node_remote_mb`
  column, and each `ops.<op>.<metric>` — is **exactly `elapsed.length`**.
- **`null` means "no reading" at that tick, not `0`.** An op with no completed transactions
  in a tick is `null`. If download is sampled on a different cadence than latency, make
  `elapsed` the union of the sample times and `null`-fill the gaps (lossless; gzip removes
  the repetition).
- **Do not emit an `agg` / overall op.** The UI derives it as the qps-weighted mean of the
  per-op latencies.
- **`download` has exactly three keys: `pct`, `mbps`, `node_remote_mb`.** Do not emit `l0_mb`,
  `read_amp`, or other extra series — the report ignores them and they only bloat the slug.

---

## 2. Metadata: identity vs display

**Identity — the grouping key** is `test` + `timestamp` + `arm` (treat a missing `arm` as
`""`). Runs sharing that triple are one run set; the UI aggregates statistics across them.

- No `arm` ⇒ one invocation = one set.
- `arm: "a"` / `"b"` on runs sharing a `timestamp` ⇒ that invocation splits into two sets.
- Separate invocations differ on `timestamp` ⇒ separate sets. (An invocation is the sample
  boundary; repetitions of the same config across two invocations do **not** pool.)

**Display / provenance — NOT keyed:** `version`, `built`, `settings`, `commit`, `branch`.
Shown in the provenance table, merged across sets when equal and split when they differ.

- **`version` is a SHORT build identifier** the generator produces — a release tag, a sha, or
  `sha-dirty` — shown **as-is** by the report. Keep it minimal: the full `version()` string
  (`CockroachDB CCL v26.1.0-…-dev-<sha>[-dirty] (amd64, built …, go…)`) bloats the slug for no
  benefit. Recommended derivation from `version()`:
  1. pull the build time out of the build info for `built`;
  2. remove the build info — everything from the opening `(` onward;
  3. drop the `CockroachDB CCL ` prefix → the version identifier;
  4. if it contains `-dev-`, keep only the suffix after `-dev-` (typically a full commit sha,
     or sha with a `-dirty` suffix).
- **`built`** carries the build time as a display-ready string (step 1 above, or from wherever
  the generator has it) — the report no longer parses it out of `version`. Omit ⇒ no "built" row.
- `commit` / `branch` can't be derived from a sha — include them for a branch + subject
  provenance row; omit and provenance degrades to the build id only. **Truncate `commit` to
  ≤40 chars** (the report shows at most 40; longer just bloats the slug).
- Put `nodes=<N>` in `test` for per-node MB/s axis labels (absent ⇒ cluster-total).

**Repeat the full `metadata` on every run** — it gzips to nothing, makes each run
self-describing, and keeps runs mergeable when links are combined. **Emit control-config
runs before experiment-config runs**: first-appearance order sets the A/B color roles
(set 1 → control/orange, set 2 → experiment/blue).

---

## 3. Report link (URL fragment)

Wrap the runs, gzip once, base64url, and place after `#`:

```
payload  = { "runs": [ run1, run2, …, runN ] }     // each runK = a §1 object
fragment = base64url( gzip( utf8( JSON.stringify(payload) ) ) )
url      = <report-base-url> + "#" + fragment
```

- **Wrapper object, not a bare array.** The `runs` key is what distinguishes this from older
  link shapes; a bare array would collide with them.
- **Join then compress.** The join is the `runs` array; gzip the whole wrapper once so
  repetition across runs (identical metadata, similar series) compresses out.
- **gzip specifically** (RFC 1952, magic bytes `1f 8b`) — the decoder sniffs that header.
  Use `compress/gzip`; not raw flate or zlib.
- **base64url** = base64 with `+`→`-`, `/`→`_`, and `=` padding dropped — exactly Go's
  `base64.RawURLEncoding`.

### Go sketch

```go
runs := []json.RawMessage{ /* each summary_report.json, as written to disk */ }
j, _ := json.Marshal(struct {
    Runs []json.RawMessage `json:"runs"`
}{runs})

var buf bytes.Buffer
gz := gzip.NewWriter(&buf)
_, _ = gz.Write(j)
_ = gz.Close()

fragment := base64.RawURLEncoding.EncodeToString(buf.Bytes())
url := reportBaseURL + "#" + fragment
```

The on-disk file and the URL-embedded run are byte-identical, so this is just: collect the
files, wrap, gzip, base64url.

---

## 4. Not the generator's responsibility

- **UI control state** (`sel`, `ctrl`): omit ⇒ the report opens at defaults; the UI writes
  these into the fragment as the viewer interacts.
- **Short links** (`ref`): a UI "share" action that uploads the payload and swaps in a
  pointer. The in-test link is always the inline `{ "runs": … }` form.

## 5. Size

Inline is infra-free but the fragment scales with the data; the columnar body + `null`-fill
keep it small. Payloads large enough to exceed practical URL lengths are what the UI's
share/short-link path exists for — the generator does not handle that case.
