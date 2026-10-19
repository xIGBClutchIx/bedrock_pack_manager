import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI lives in src/web and builds into dist/web, which the server serves (or embeds in the exe).
// In dev, Vite proxies /api to the server started by `npm run dev:server`.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:5174", changeOrigin: false },
    },
  },
});
