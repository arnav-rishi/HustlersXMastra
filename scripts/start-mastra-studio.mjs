/**
 * Wrapper that starts Mastra Studio with two fixes applied:
 * 1. Injects NODE_OPTIONS=--import to preload globalThis.mastra stub
 *    (fixes telemetry-config.mjs ReferenceError bug in mastra@0.10.x on Node 22)
 * 2. zod@4 must be installed at root (fixes ERR_PACKAGE_PATH_NOT_EXPORTED: zod/v4)
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn } from "child_process";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const preloadPath = join(__dirname, "mastra-preload.mjs")
  .replace(/\\/g, "/");

const mastraBin = join(projectRoot, "node_modules", ".bin", "mastra.CMD");
const mastraBinAlt = join(projectRoot, "node_modules", ".bin", "mastra");

const bin = existsSync(mastraBin) ? mastraBin : mastraBinAlt;

const env = {
  ...process.env,
  NODE_OPTIONS: `--import file:///${preloadPath}`,
};

console.log("🚀 Starting Mastra Studio with globalThis.mastra preload fix...");
console.log(`   Preload: file:///${preloadPath}`);
console.log(`   Binary:  ${bin}`);

const proc = spawn(bin, ["dev"], {
  env,
  stdio: "inherit",
  cwd: projectRoot,
  shell: false,
});

proc.on("error", (err) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});

proc.on("exit", (code) => process.exit(code ?? 0));
