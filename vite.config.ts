import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

export default defineConfig({
  plugins: [react(), runtimeErrorOverlay()],
 server: {
  host: true,
  allowedHosts: [
    ".replit.dev",
    ".spock.replit.dev",
    "localhost",
    "127.0.0.1",
    "f105033c-0fdb-48be-8ad3-768223c19035-00-140ptk3nzcxi3.spock.replit.dev"
  ]
},

});

  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached"),
    },
  },

  root: path.resolve(import.meta.dirname, "client"),

  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
});
