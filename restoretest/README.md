# restoretest — online-restore perf-breakdown report

**`index.html` in this directory is a generated build artifact — do not edit it by hand.**

It is a single, self-contained, zero-dependency HTML file that GitHub Pages serves at
<https://cockroachdb.github.io/restoretest/> (and that `analyze_or_perf.py` opens locally over
`file://`). Everything else in this directory is its **source**: a Vite + TypeScript project that
compiles down to that one file. The built `index.html` is checked in — there is no CI build, so
after changing any source you must rebuild and commit the regenerated `index.html`.

## Invariants (don't break these)

- **One self-contained `index.html`** with no external network requests — it must work opened
  straight off `file://` as well as from Pages. Enforced by `vite-plugin-singlefile`;
  `assetsInlineLimit` is effectively infinite and `cssCodeSplit` is off so everything inlines.
- **`minify: false`** — the shipped file stays readable/greppable/debuggable; size is irrelevant
  for this tool.
- **The HTML bytes are independent of the data.** The payload arrives at runtime (URL `#fragment`
  or an inline inject — see below), so one built `index.html` serves every report. Never bake data
  into the build.
- **Two `window.*` names are external contracts** — do not rename them: `window.__ARMS__` (the host
  inject point, seeded by the `/*__ARMS_INJECT__*/` marker in `index-dev.html`) and
  `window.__ENCODE_ARMS__` (the copy-link API). Everything else is plain ES imports between the
  `src/` layers.

## Rebuild after changing source

```bash
npm install        # once
npm run build      # tsc typecheck + vite build -> regenerates ./index.html
git add index.html src ...   # commit the source AND the rebuilt index.html
```

`npm run build` bundles the Vite entry `index-dev.html` (which pulls in `src/`) into the single
`./index.html`. The entry is named `index-dev.html`, not `index.html`, only so the source entry
and the built output can live side by side in this one directory without clobbering each other.

## Other commands

```bash
npm run dev        # vite dev server (hot reload) — open the printed URL at /index-dev.html, append a #<payload>
npm test           # unit tests: golden (vs pre-refactor CORE) + ported self_test  (hermetic)
npm run smoke      # browser smoke test: boots the built index.html in Chrome, diffs render
npm run typecheck  # tsc --noEmit
```

## Feeding it data

The report ingests a **flat list of runs** — each a `summary_report.json` (v:2) carrying a
`metadata` block. The UI groups them into **run sets** (`app/runsets.ts`, `runsToSets`) by
identity — `test` + `timestamp` + `arm` — and the picker chooses 1–2 sets to render as the
ctl/exp arms. The wire format (body + slug encoding) is specified in `summary_report_spec.md`.

Three sources, in priority order (see `resolveAndRender`):

1. `window.__ARMS__` — a payload injected inline (the Go-host path): `{runs}` or a bare run array.
2. URL `#<fragment>` — base64url of the payload (gzip optional). The test emits this; the
   report re-persists `{runs, sel, ctrl}` (or `{ref, …}` for a shared short link). Dev/smoke:
   ```js
   location.hash = Buffer.from(JSON.stringify({ runs })).toString("base64url");
   ```
3. The drag-and-drop file picker (any tree of `run_*/summary_report.json`; runs self-group).

`test/fixture.ts` builds deterministic synthetic runs (`dualRuns`/`soloRuns`) + arm catalogs
(`dualArms*`/`soloArms*`) used by the tests.

## Verification model

- **`test/golden.test.ts`** runs the pre-refactor CORE (preserved verbatim at
  `test/golden/core.reference.cjs`, extracted from `test/golden/index.reference.html`) and
  the new layered modules on identical inputs and asserts byte-identical `analyze()` ctx and
  `data_json()`, plus that `bake_svg()` runs for every op without throwing. Render comparison
  (`render_body`, tables) is intentionally **not** asserted here — the report's
  layout/controls/labels are being actively redesigned, so compute fidelity is the durable
  invariant this gate guards; render output is covered behaviorally by the SMOKE suite below.
- **`test/self_test.test.ts`** ports the original `self_test()` unit assertions.
- **`test/smoke.test.ts`** (`npm run smoke`) loads the built single-file report in real
  Chrome and asserts it boots, renders, and reacts to controls with no page errors — the
  end-to-end check the golden test can't cover (ESM strict-mode, module load-order, DOM).
- **`test/{sticky,hover,gestures}.test.ts`** drive the built file in real Chrome for the
  interactive behaviors. These and the smoke test need Chrome, so they are **gated behind
  `SMOKE=1`**: plain `npm test` runs only the hermetic golden + self_test; run
  `SMOKE=1 npx vitest run` for the full suite.

The report's logic was ported **verbatim** from the original pre-refactor single-file report — there
is no older behavioral spec, so the golden test (not re-derivation) is what guarantees fidelity.
When you intentionally change compute or render output, update the files under `test/golden/`
deliberately and say why in the commit.

## Layout

```
index.html         BUILT, served by Pages / opened by analyze_or_perf.py (generated)
index-dev.html     Vite entry (source template that builds index.html)
src/
  model/     constants.ts, types.ts            (data model)
  compute/   stats, ingest, series, cells, analyze, interp   (pure, DOM-free)
  format/    format.ts                         (string formatters; shared)
  render/    tables.ts, svg.ts, body.ts        (data -> HTML/SVG strings)
  chart/     chart.ts                          (interactive SVG renderer)
  app/       bootstrap.ts                      (data-source resolve, catalog, picker, share)
  core/      index.ts                          (assembles window.ORCORE)
  main.ts    entry: import core -> chart -> bootstrap
  sticky.ts  dashboard sticky-header / squishing-graph scroll behavior
  clipboard.ts, util.ts   small shared helpers
test/              golden + unit + browser (SMOKE) tests
```

Lower layers never import higher ones: `model → compute → format → render`/`chart → app`. The
`format/` helpers are shared by both `render/tables` and `chart/chart` (the de-dup win). `analyze()`
in `compute/` is the driver: raw arm payload → the `Ctx` object every renderer consumes.

## Chart interaction model

All pointer handling for the interactive charts lives in `chart/chart.ts`; know this before
touching it:

- **Cursor**: a synced vertical line draws over every plot, and the readout names the series/time
  under it (e.g. `45s · B run 5 · 62% dl`). The skew chart labels each *enabled* level in its own
  shade, not a single hard-coded mean.
- **Run isolation** is `PIN ?? HOVER` (`isoRun()`): hovering a run isolates it (bold across all
  charts, others dimmed); clicking a run *pins* that isolation so it survives scrubbing other
  times. A plain click with nothing pinned/hovered falls back to the arm/plot cycle.
- **Gestures**: single-click = pin/un-pin the run under the pointer, or (empty area) toggle
  summary↔all-runs; double-click = cycle arms (A / B / both, shared with the control-bar button);
  drag = zoom; reset zoom via the control-bar button or Escape (double-click does *not* reset).
- Cursor and drag-zoom resolve their scrub-rect through the shared `<svg>`, so pointer events over
  a run's fat hit-path still register. Covered by `test/{hover,gestures}.test.ts`.
