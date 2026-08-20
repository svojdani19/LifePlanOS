// ─────────────────────────────────────────────────────────────────────────────
// Can the migration history rebuild the database from nothing?
//
// This repo's dev database was created with `prisma db push`, so
// `_prisma_migrations` lags and some tables exist without a migration that
// creates them. A migration that ALTERs such a table passes on dev — the column
// is already there — and fails on an empty database. CI is the first place that
// ever runs against an empty database, so this is the check that would
// otherwise turn CI red on its first run for reasons unrelated to the change
// under test.
//
// It fails on NEW drift and records the two known cases, so the bug class is
// blocked from here forward without pretending the existing history is clean.
//
//   npx tsx scripts/check-migration-history.ts
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync } from "fs";

const DIR = "prisma/migrations";

/**
 * Tables whose CREATE is missing from the history.
 *
 * Empty, and meant to stay that way. It held VocationalEntry and
 * EconomicScenario — introduced with `prisma db push`, so the dev database had
 * them and the history did not, and CI failed on
 * `relation "VocationalEntry" does not exist` for weeks. The missing CREATEs
 * were authored in 20260804110000_vocational_and_economic_tables.
 *
 * A name here is a promise to repair, not a licence to ignore.
 */
const KNOWN_MISSING = new Set<string>([]);

function main() {
  const dirs = readdirSync(DIR).filter((d) => d !== "migration_lock.toml");
  const sqlOf = (d: string): string => {
    try { return readFileSync(`${DIR}/${d}/migration.sql`, "utf8"); } catch { return ""; }
  };
  const all = dirs.map((d) => ({ d, sql: sqlOf(d) }));
  const creates = new Set<string>();
  for (const { sql } of all) {
    for (const m of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) creates.add(m[1]);
  }

  const drift = new Map<string, string[]>();
  for (const { d, sql } of all) {
    for (const m of sql.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?"?(?:[A-Za-z_]+"?\."?)?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) {
      const table = m[1];
      if (creates.has(table)) continue;
      drift.set(table, [...(drift.get(table) ?? []), d]);
    }
  }

  const unexpected = [...drift.entries()].filter(([t]) => !KNOWN_MISSING.has(t));
  const stillMissing = [...KNOWN_MISSING].filter((t) => drift.has(t));
  const repaired = [...KNOWN_MISSING].filter((t) => !drift.has(t));

  for (const t of repaired) console.log(`✓ "${t}" is no longer drifted — remove it from KNOWN_MISSING.`);
  for (const t of stillMissing) console.log(`· "${t}" — known missing CREATE TABLE (pre-existing; migrate deploy cannot rebuild from empty)`);

  if (unexpected.length) {
    console.error(`\n✗ ${unexpected.length} table(s) are ALTERed by a migration that never creates them:`);
    for (const [t, ds] of unexpected) console.error(`    "${t}" — altered in ${ds.join(", ")}`);
    console.error("\nA migration that only works because the dev database already had the object");
    console.error("cannot rebuild the schema from nothing. Add the CREATE, or fold it into the");
    console.error("migration that needs it.");
    process.exit(1);
  }
  console.log(`\n${dirs.length} migrations checked; no new drift.`);
}

main();
