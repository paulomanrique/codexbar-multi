import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node24",
    outDir: "dist",
    emptyOutDir: true,
    lib: { entry: "src/index.ts", formats: ["es"], fileName: "index" },
    rollupOptions: { external: [/^node:/, /^@napi-rs\//] },
  },
});
