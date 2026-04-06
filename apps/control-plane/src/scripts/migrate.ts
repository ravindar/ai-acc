import { getConfig } from "../config.js";
import { createDatabase } from "../lib/database.js";
import { runMigrations } from "../lib/migrations.js";

async function main() {
  const config = getConfig();
  const db = createDatabase(config);

  try {
    await db.ping();
    await runMigrations(db);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
