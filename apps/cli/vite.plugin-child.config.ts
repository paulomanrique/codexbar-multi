import { defineConfig } from "vite";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  build: {
    target: "node24",
    outDir: "dist-sea-child",
    emptyOutDir: true,
    lib: {
      entry: "src/plugin-sandbox-child.ts",
      formats: ["es"],
      fileName: "plugin-sandbox-child",
    },
    rollupOptions: {
      external: [/^node:/],
      output: {
        entryFileNames: "plugin-sandbox-child.mjs",
        codeSplitting: false,
      },
    },
  },
});
