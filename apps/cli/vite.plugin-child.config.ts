import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
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
