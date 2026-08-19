import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/main",
    emptyOutDir: true,
    lib: {
      entry: {
        index: "src/main/index.ts",
        "sqlite-worker": "../../packages/platform/src/node-persistence-worker.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: { external: ["electron", /^node:/, /^@napi-rs\//] },
  },
});
