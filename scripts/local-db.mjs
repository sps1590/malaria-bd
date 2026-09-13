// Local development Postgres (no Docker / system install needed).
// Usage: npm run db:local   → keeps running until Ctrl+C
import { existsSync } from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const databaseDir = path.resolve(".pgdata");
const port = Number(process.env.LOCAL_PG_PORT ?? 5433);

const pg = new EmbeddedPostgres({
  databaseDir,
  user: "postgres",
  password: "postgres",
  port,
  persistent: true,
});

if (!existsSync(path.join(databaseDir, "PG_VERSION"))) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase("malaria");
} catch {
  /* already exists */
}

console.log(`Local Postgres ready: postgres://postgres:postgres@localhost:${port}/malaria  (Ctrl+C to stop)`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
