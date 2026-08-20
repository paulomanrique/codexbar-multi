import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    target: "node24",
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: {
        index: resolve(import.meta.dirname, "src/index.ts"),
        "plugin-sandbox-child": resolve(import.meta.dirname, "src/plugin-sandbox-child.ts"),
      },
      formats: ["es"],
      fileName: (_format, entryName) => entryName,
    },
    rollupOptions: {
      external: [/^node:/, /^@napi-rs\//],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
      },
    },
  },
});
