import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    watch: {
      ignored: ["**/coverage/**", "**/playwright-report/**", "**/test-results/**"],
    },
    proxy: {
      "/v1": {
        target: process.env.VITE_BFF_URL ?? "http://localhost:8080",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
