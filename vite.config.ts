import { defineConfig } from "vite";

// The dashboard is plain Preact, bundled into web-dist/ and served by the Rushes server.
export default defineConfig({
  root: "web",
  base: "/",
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  build: { outDir: "../web-dist", emptyOutDir: true, assetsDir: "assets", sourcemap: false },
});
