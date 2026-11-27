// Removes the previous build so deleted sources never linger in the published package.
import { rmSync } from "node:fs";
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
