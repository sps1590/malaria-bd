// Proves the analyst's safety net at the database level: inside a READ ONLY transaction (exactly how the
// analyst runs every query) PostgreSQL rejects any write, even if one somehow reached it.
//   node --env-file=.env.local scripts/verify-readonly.mjs
import postgres from "postgres";

const url = process.env.DATABASE_URL || process.env.DATABASE_POSTGRES_URL || process.env.POSTGRES_URL;
if (!url) throw new Error("Set DATABASE_URL first.");
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

const attempts = [
  ["DELETE", "DELETE FROM mis_monthly WHERE upazila_id = -1"],
  ["UPDATE", "UPDATE mis_monthly SET cases = cases WHERE upazila_id = -1"],
  ["INSERT", "INSERT INTO alerts (kind, level) VALUES ('probe', 'probe')"],
  ["DROP", "DROP TABLE IF EXISTS analyst_probe_table"],
  ["CREATE", "CREATE TABLE analyst_probe_table (x int)"],
  ["TRUNCATE", "TRUNCATE analyst_probe_table"],
];

let failed = false;
const [{ before }] = await sql`SELECT count(*)::int AS before FROM mis_monthly`;
for (const [label, statement] of attempts) {
  try {
    await sql.begin("read only", async (tx) => {
      await tx.unsafe("SET LOCAL statement_timeout = 10000");
      await tx.unsafe(statement);
    });
    console.log(`✗ ${label}: was NOT blocked`);
    failed = true;
  } catch (err) {
    console.log(`✓ ${label}: blocked — ${err.message}`);
  }
}
// a plain SELECT still works in the same mode
const rows = await sql.begin("read only", (tx) => tx.unsafe("SELECT count(*)::int AS n FROM mis_monthly"));
const [{ after }] = await sql`SELECT count(*)::int AS after FROM mis_monthly`;
console.log(`✓ SELECT works in read-only mode (${rows[0].n} rows); row count before/after: ${before} / ${after}`);
if (before !== after) failed = true;
await sql.end();
process.exit(failed ? 1 : 0);
