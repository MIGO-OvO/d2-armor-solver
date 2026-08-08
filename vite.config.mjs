import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  define: {
    // Injected at build time from the environment; missing vars become "" (never "undefined").
    __BUNGIE_API_KEY__: JSON.stringify(process.env.BUNGIE_API_KEY || ""),
    __BUNGIE_OAUTH_CLIENT_ID__: JSON.stringify(process.env.BUNGIE_OAUTH_CLIENT_ID || ""),
    __BUNGIE_OAUTH_CLIENT_SECRET__: JSON.stringify(process.env.BUNGIE_OAUTH_CLIENT_SECRET || ""),
  },
  build: {
    target: "es2022",
    emptyOutDir: true,
    sourcemap: false,
  },
});
