/**
 * Preload script injected via NODE_OPTIONS=--import
 * Runs BEFORE any other module in the process.
 * Sets globalThis.mastra so telemetry-config.mjs can reference it
 * without crashing (mastra@0.10.x bug on Node 22).
 */
globalThis.mastra = { telemetry: null };
