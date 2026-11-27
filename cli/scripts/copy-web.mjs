// Copies the browser UI (built at the repo root into dist-web/) to dist/web-app so `cepheus web`
// works from the published package. Source maps are left out to keep the package small.
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../../dist-web", import.meta.url));
const to = fileURLToPath(new URL("../dist/web-app", import.meta.url));
if (!existsSync(`${from}/index.html`)) {
  console.error("dist-web/index.html not found. Run `npx vite build --config vite.config.web.ts` at the repo root first.");
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith(".map") });
console.log("Copied web UI to dist/web-app");
