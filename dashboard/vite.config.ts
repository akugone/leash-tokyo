import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { leashDemoPlugin } from "./scripts/demo-server";

export default defineConfig({
  plugins: [react(), leashDemoPlugin()],
  server: { port: 5173 },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 600 },
});
