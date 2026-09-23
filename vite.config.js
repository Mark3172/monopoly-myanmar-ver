import { defineConfig } from "vite";
import { lobbyPlugin } from "./server/lobbyPlugin.js";

export default defineConfig({
  base: "./",
  plugins: [lobbyPlugin()],
  server: {
    host: "0.0.0.0",
    port: 43180,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 43180,
    strictPort: true,
  },
});
