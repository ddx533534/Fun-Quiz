import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/jev/",
  plugins: [react()],
  build: { outDir: "../web/dist/jev", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5174, proxy: { "/api": "http://127.0.0.1:8001" } },
});
