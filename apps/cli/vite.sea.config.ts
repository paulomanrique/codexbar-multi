import { defineConfig } from "vite";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  resolve: {
    alias: {
      "@napi-rs/keyring": new URL("./src/sea-keyring.ts", import.meta.url).pathname,
    },
  },
  build: {
    target: "node24",
    outDir: "dist-sea",
    emptyOutDir: true,
    lib: { entry: "src/sea-entry.cts", formats: ["cjs"], fileName: "sea" },
    rollupOptions: {
      external: [/^node:/],
      output: { codeSplitting: false },
    },
  },
});
