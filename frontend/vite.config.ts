/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Read .env files from the repository root so frontend and backend share one
  // .env.example. Only VITE_-prefixed variables are exposed to the browser.
  envDir: "..",
  server: {
    port: 5173,
    proxy: {
      // During development, forward API calls to the FastAPI backend.
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
