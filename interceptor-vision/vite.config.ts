import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base keeps the demo working both at the repository root preview and
// under a GitHub Pages project sub-path.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    target: "es2020",
    assetsInlineLimit: 0,
  },
});
