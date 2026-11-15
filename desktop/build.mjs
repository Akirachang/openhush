// Bundles the Electron main and preload scripts.
import { build } from "esbuild";

await build({
  entryPoints: { main: "desktop/main.ts", preload: "desktop/preload.ts" },
  outdir: "desktop/dist",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  logLevel: "warning",
});
console.log("desktop: built");
