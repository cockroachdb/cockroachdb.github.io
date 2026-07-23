import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Builds the report into a single self-contained index.html — the file GitHub Pages serves at
// cockroachdb.github.io/restoretest/ and analyze_or_perf.py opens locally. One file, no external
// requests, works on file:// and Pages. minify is off so the shipped file stays
// readable/greppable/debuggable — size is irrelevant for this tool.
//
// Source and built output share this one directory, so the Vite entry is index-dev.html (holds
// the <script src=./src/main.ts> + the host-inject marker) to avoid clobbering the built
// index.html. Vite writes the bundle to dist/ (gitignored); the emit-index plugin then publishes
// it as ./index.html — the served file, checked in (there is no CI build).
const ROOT = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    viteSingleFile(),
    {
      name: "emit-index",
      closeBundle() {
        copyFileSync(resolve(ROOT, "dist/index-dev.html"), resolve(ROOT, "index.html"));
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true, // dedicated build dir, safe to wipe each build
    minify: false,
    target: "es2020",
    assetsInlineLimit: 100 * 1024 * 1024, // inline everything
    cssCodeSplit: false,
    rollupOptions: { input: resolve(ROOT, "index-dev.html") },
  },
});
