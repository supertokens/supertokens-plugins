import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";
import peerDepsExternal from "rollup-plugin-peer-deps-external";
import * as path from "path";
import packageJson from "./package.json";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

export default defineConfig(() => {
  return {
    root: __dirname,
    plugins: [
      react(),
      dts({
        entryRoot: "src",
        tsconfigPath: path.join(__dirname, "tsconfig.json"),
      }),
      peerDepsExternal(),
      cssInjectedByJsPlugin(),
    ],

    build: {
      outDir: "dist",
      sourcemap: false,
      emptyOutDir: true,
      commonjsOptions: {
        transformMixedEsModules: true,
      },
      lib: {
        // Could also be a dictionary or array of multiple entry points.
        entry: "src/index.ts",
        fileName: "index",
        name: packageJson.name,
        // Change this to the formats you want to support.
        // Don't forget to update your package.json as well.
        formats: ["es" as const, "cjs" as const],
      },
      rollupOptions: {
        cache: false,
      },
    },
  };
});
