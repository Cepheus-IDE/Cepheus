// Web build of Cepheus IDE: the same index.html and src/ as the desktop app, with every
// `@tauri-apps/*` import replaced by a shim from web/shims (see web/main-web.ts).
//
//   npx vite build --config vite.config.web.ts                       → dist-web/ (for `cepheus web`)
//   npx vite build --config vite.config.web.ts --base /Cepheus/app/  → GitHub Pages
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Swaps the desktop entry for the web entry (which picks a backend, then imports src/main.tsx). */
function webEntry(): Plugin {
  return {
    name: "cepheus-web-entry",
    transformIndexHtml: {
      order: "pre", // before Vite collects the entry scripts
      handler: (html) =>
        html
        .replace('src="/src/main.tsx"', 'src="/web/main-web.ts"')
        .replace("<title>Cepheus IDE</title>", '<title>Cepheus IDE</title>\n    <meta name="description" content="Cepheus IDE in the browser" />'),
    },
  };
}

export default defineConfig({
  plugins: [react(), webEntry()],
  clearScreen: false,
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/core$/, replacement: here("./web/shims/core.ts") },
      { find: /^@tauri-apps\/api\/event$/, replacement: here("./web/shims/event.ts") },
      { find: /^@tauri-apps\/api\/window$/, replacement: here("./web/shims/window.ts") },
      { find: /^@tauri-apps\/api\/webview$/, replacement: here("./web/shims/webview.ts") },
      { find: /^@tauri-apps\/api\/path$/, replacement: here("./web/shims/path.ts") },
      { find: /^@tauri-apps\/api$/, replacement: here("./web/shims/core.ts") },
      { find: /^@tauri-apps\/plugin-dialog$/, replacement: here("./web/shims/dialog.ts") },
      { find: /^@tauri-apps\/plugin-opener$/, replacement: here("./web/shims/opener.ts") },
    ],
  },
  server: {
    port: 1421,
    strictPort: false,
    watch: { ignored: ["**/src-tauri/**", "**/cli/node_modules/**"] },
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    target: "es2021",
    chunkSizeWarningLimit: 8000,
  },
  worker: { format: "es" },
});
