import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const buildChannel = process.env.BUILD_CHANNEL === "develop" ? "develop" : "stable";

export default defineConfig({
  base: "./",
  define: {
    // Injected at build time from the environment; missing vars become "" (never "undefined").
    __BUNGIE_API_KEY__: JSON.stringify(process.env.BUNGIE_API_KEY || ""),
    __BUNGIE_OAUTH_CLIENT_ID__: JSON.stringify(process.env.BUNGIE_OAUTH_CLIENT_ID || ""),
    __BUNGIE_OAUTH_CLIENT_SECRET__: JSON.stringify(process.env.BUNGIE_OAUTH_CLIENT_SECRET || ""),
    __BUILD_CHANNEL__: JSON.stringify(buildChannel),
    __BUILD_COMMIT_SHA__: JSON.stringify(process.env.BUILD_COMMIT_SHA || ""),
  },
  build: {
    target: "es2022",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        portal: path.join(projectRoot, "index.html"),
        app: path.join(projectRoot, "app", "index.html"),
      },
    },
  },
});
