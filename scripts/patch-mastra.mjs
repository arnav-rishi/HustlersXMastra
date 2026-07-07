/**
 * Patches the Mastra CLI generated telemetry-config.mjs which has a bug
 * in mastra@0.10.x where the `mastra` variable is referenced without
 * being imported, causing ReferenceError on Node.js v22.
 *
 * Usage: node scripts/patch-mastra.mjs
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const OUTPUT_DIR = join(process.cwd(), ".mastra", "output");
const TELEMETRY_FILE = join(OUTPUT_DIR, "telemetry-config.mjs");
const INDEX_FILE = join(OUTPUT_DIR, "index.mjs");

// Step 1: Run the mastra bundler (build only, no server)
console.log("📦 Bundling Mastra project...");
try {
  execSync("node_modules/.bin/mastra build", { stdio: "inherit" });
} catch {
  // mastra build may not exist in v0.10.x — skip if so
  console.log("⚠️  mastra build not available, checking existing output...");
}

// Step 2: Check output exists
if (!existsSync(TELEMETRY_FILE)) {
  console.error("❌ .mastra/output/telemetry-config.mjs not found. Run `npx pnpm dev:ui` once first to generate the bundle, then run this script.");
  process.exit(1);
}

// Step 3: Patch the file
let content = readFileSync(TELEMETRY_FILE, "utf8");
if (content.includes("var mastra$1 = mastra") && !content.startsWith("import { mastra }")) {
  const patched = `import { mastra } from './index.mjs';\n` + content;
  writeFileSync(TELEMETRY_FILE, patched, "utf8");
  console.log("✅ Patched telemetry-config.mjs — added missing import");
} else {
  console.log("ℹ️  telemetry-config.mjs looks fine, no patch needed.");
}

// Step 4: Start the server directly using Node.js
if (existsSync(INDEX_FILE)) {
  console.log("🚀 Starting Mastra server at http://localhost:4111 ...");
  const { spawn } = await import("child_process");
  const server = spawn("node", [INDEX_FILE], { stdio: "inherit" });
  server.on("error", (err) => {
    console.error("Server error:", err.message);
    process.exit(1);
  });
} else {
  console.log("ℹ️  No index.mjs found. The patched telemetry-config.mjs is ready — rerun `npx pnpm dev:ui`");
}
