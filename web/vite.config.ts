import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development, Vite serves the UI and proxies /api to the Flask server.
// In production, `npm run build` writes to web/dist, which Flask serves
// directly (see main.py), so the ESP32 tunnel and the UI share one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
