import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("./", import.meta.url));
const template = fileURLToPath(new URL("../app/index.html", import.meta.url));

export default defineConfig({
  root,
  base: "./",
  clearScreen: false,
  server: { host: "127.0.0.1", port: 5178, strictPort: true },
  // Desktop is offline, but unlike file:// it supports module Workers.
  // Never inherit credentials from the web deployment environment.
  define: {
    __BUNGIE_API_KEY__: JSON.stringify(""),
    __BUNGIE_OAUTH_CLIENT_ID__: JSON.stringify(""),
    __BUNGIE_OAUTH_CLIENT_SECRET__: JSON.stringify(""),
    __BUILD_CHANNEL__: JSON.stringify("stable"),
    __BUILD_COMMIT_SHA__: JSON.stringify(""),
    __OFFLINE_MODE__: JSON.stringify("false"),
  },
  plugins: [{
    name: "shared-solver-template",
    resolveId(id) { if (id === "virtual:solver-template") return "\0solver-template"; },
    load(id) {
      if (id !== "\0solver-template") return;
      this.addWatchFile(template);
      const body = readFileSync(template, "utf8").match(/<body>([\s\S]*?)<\/body>/)?.[1];
      if (!body) throw new Error("Shared solver template has no body");
      return `export default ${JSON.stringify(body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""))};`;
    },
  }],
  build: { outDir: "../dist-desktop", emptyOutDir: true, target: "es2022" },
});
