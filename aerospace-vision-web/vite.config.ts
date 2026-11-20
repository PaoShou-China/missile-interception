import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Relative base makes the same build work on GitHub Pages project sites,
// user sites, or any static subtree.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three")) return "three";
          if (id.includes("node_modules/echarts") || id.includes("node_modules/zrender")) return "echarts";
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    reporters: ["default"],
  },
});
