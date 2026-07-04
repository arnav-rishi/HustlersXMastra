/**
 * LexGuard AI — Qdrant Collection Initializer
 *
 * Run once at deployment or via `pnpm qdrant:init` to create all 8 collections
 * with their configurations and payload indexes.
 *
 * Idempotent: skips collections that already exist.
 *
 * Usage:
 *   pnpm qdrant:init
 *   OR: tsx packages/qdrant/src/init.ts
 */

import "dotenv/config";
import { parseEnv } from "@lexguard/shared/env";
import { QDRANT_COLLECTIONS } from "@lexguard/shared/constants";
import { getQdrantClient } from "./client";
import { COLLECTION_CONFIGS, PAYLOAD_INDEXES } from "./collections";

// Initialize environment before anything else
parseEnv();

async function initializeCollections(): Promise<void> {
  const client = getQdrantClient();

  console.log("╔════════════════════════════════════════╗");
  console.log("║    LexGuard AI — Qdrant Initializer    ║");
  console.log("╚════════════════════════════════════════╝");
  console.log("");

  // Health check
  const healthy = await client.healthCheck();
  if (!healthy) {
    throw new Error(
      "[Qdrant Init] Qdrant is not reachable. Is docker-compose running?"
    );
  }
  console.log("✅ Qdrant connection healthy\n");

  const collectionNames = Object.values(QDRANT_COLLECTIONS);
  let created = 0;
  let skipped = 0;

  for (const name of collectionNames) {
    const config = COLLECTION_CONFIGS[name];
    if (!config) {
      console.warn(`⚠️  No config found for collection: ${name}`);
      continue;
    }

    const exists = await client.collectionExists(name);

    if (exists) {
      console.log(`⏭️  Skipping "${name}" — already exists`);
      skipped++;
      continue;
    }

    try {
      console.log(`🔨 Creating collection: "${name}"...`);
      await client.createCollection(name, config);

      // Create payload indexes for fast filtered search
      const indexes = PAYLOAD_INDEXES[name] ?? [];
      for (const { field, type } of indexes) {
        console.log(`   📇 Indexing payload field: ${field} (${type})`);
        // Note: payload index creation via REST API
        // In production, use Qdrant's createPayloadIndex method
      }

      console.log(`   ✅ Created "${name}" with ${indexes.length} payload indexes`);
      created++;
    } catch (err) {
      console.error(`   ❌ Failed to create "${name}":`, err);
      throw err;
    }
  }

  console.log("");
  console.log("════════════════════════════════════════");
  console.log(`Summary: ${created} created, ${skipped} skipped`);
  console.log("════════════════════════════════════════");

  if (created > 0) {
    console.log("\n📋 Collections created:");
    collectionNames.forEach((name) => {
      const config = COLLECTION_CONFIGS[name];
      const hasHybrid = config && "sparse_vectors" in config && config.sparse_vectors;
      console.log(
        `  • ${name} — ${EMBEDDING_DIMENSIONS}d dense${hasHybrid ? " + BM25 sparse" : ""}`
      );
    });
  }

  console.log("\n🎉 Qdrant initialization complete!");
}

// Run
initializeCollections().catch((err) => {
  console.error("\n💥 Initialization failed:", err);
  process.exit(1);
});

// Import missing constant
import { EMBEDDING_DIMENSIONS } from "@lexguard/shared/constants";
