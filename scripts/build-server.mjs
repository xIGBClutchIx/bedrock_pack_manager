// Bundle the server into one CommonJS file: Node SEA runs a single CJS script.
import { build } from "esbuild";

await build({
  entryPoints: ["src/server/main.ts"],
  outfile: "dist/server.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  // Prefer ESM entry points: some packages (jsonc-parser) ship a UMD "main" that esbuild cannot follow.
  mainFields: ["module", "main"],
  sourcemap: false,
  minify: false,
  legalComments: "none",
  // Optional native speed-ups of ssh2; it works without them and an exe cannot carry .node files.
  external: ["cpu-features", "./crypto/build/Release/sshcrypto.node"],
  define: { "process.env.BPM_BUNDLED": '"1"' },
  logLevel: "info",
});
