import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// The condition-uniqueness invariant, checked against the migration SQL itself.
//
// The defect: `20260824000000_pipeline_run_lock` deduplicated on the semantic
// key the generator uses — `lower(btrim(name))` — and then enforced the result
// with `UNIQUE (caseId, name)`. Those are different keys. The index therefore
// admitted exactly the rows the cleanup had just declared duplicates, so a
// concurrent writer producing "Low back pain" beside "low back pain" satisfied
// the constraint and put the same diagnosis on the causation map twice.
//
// There is no local Postgres in this environment, so these assert the SQL's
// shape rather than executing it. What they can prove is the property that was
// actually wrong: that the cleanup key and the enforced key are the same key.
// CI's `prisma migrate deploy` against a disposable database is what proves it
// runs.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const sqlOf = (dir: string) => readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8");

const LOCK = "20260824000000_pipeline_run_lock";
const NORMALIZED = "20260824010000_condition_normalized_uniqueness";

/** Comments carry the old strings verbatim; matching them would be vacuous. */
const stripComments = (sql: string) =>
  sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

describe("condition uniqueness migrations", () => {
  it("both migrations exist and run in order", () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => !d.startsWith("."));
    expect(dirs).toContain(LOCK);
    expect(dirs).toContain(NORMALIZED);
    // Prisma applies migrations in lexical directory order.
    expect(NORMALIZED > LOCK).toBe(true);
  });

  it("enforces uniqueness on the SAME key the cleanup normalizes by", () => {
    const sql = stripComments(sqlOf(NORMALIZED));
    // The cleanup groups on this key…
    expect(sql).toMatch(/DISTINCT ON \("caseId", lower\(btrim\("name"\)\)\)/);
    // …and the index enforces that same key. This is the whole fix.
    expect(sql).toMatch(/CREATE UNIQUE INDEX[\s\S]*?ON "Condition" \("caseId", lower\(btrim\("name"\)\)\)/);
  });

  it("retires the case-sensitive index rather than leaving both", () => {
    const sql = stripComments(sqlOf(NORMALIZED));
    expect(sql).toMatch(/DROP INDEX IF EXISTS "Condition_caseId_name_key"/);
    // …and does not recreate a case-sensitive one.
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[^\n]*ON "Condition"\s*\(\s*"caseId",\s*"name"\s*\)/);
  });

  it("the earlier migration is the one that had the mismatch — proving this is not vacuous", () => {
    const sql = stripComments(sqlOf(LOCK));
    expect(sql).toMatch(/DISTINCT ON \("caseId", lower\(btrim\("name"\)\)\)/);
    // Normalized cleanup, case-sensitive enforcement: the two disagree.
    expect(sql).toMatch(/CREATE UNIQUE INDEX "Condition_caseId_name_key" ON "Condition"\("caseId", "name"\)/);
  });

  it("repoints dependent care items before deleting any condition", () => {
    const sql = stripComments(sqlOf(NORMALIZED));
    const update = sql.indexOf('UPDATE "FutureCareItem"');
    const del = sql.indexOf('DELETE FROM "Condition"');
    expect(update).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(-1);
    // The FK is ON DELETE SET NULL, so deleting first would silently strip the
    // diagnosis link off every item pointing at a losing copy.
    expect(update).toBeLessThan(del);
  });

  it("keeps a physician-confirmed row as the survivor", () => {
    const sql = stripComments(sqlOf(NORMALIZED));
    // A person's assertion must not be the copy that disappears.
    expect(sql).toMatch(/ORDER BY[\s\S]*?"physicianConfirmed" DESC/);
  });

  it("preserves the stored name — only the constraint is normalized", () => {
    const sql = stripComments(sqlOf(NORMALIZED));
    // Nothing rewrites Condition.name; a clinician keeps the capitalisation
    // they read.
    expect(sql).not.toMatch(/UPDATE "Condition"\s+SET\s+"name"/i);
  });

  it("is scoped per case, so one firm's conditions cannot collide with another's", () => {
    const sql = stripComments(sqlOf(NORMALIZED));
    // Every Condition belongs to exactly one Case, and Case carries firmId, so
    // case scoping is tenant scoping. An index omitting caseId would make two
    // firms' identically-named diagnoses collide.
    const index = sql.match(/CREATE UNIQUE INDEX[\s\S]*?;/)?.[0] ?? "";
    expect(index).toContain('"caseId"');
    for (const clause of [
      /DISTINCT ON \("caseId"/,
      /s\."caseId" = c\."caseId"/,
    ]) {
      expect(sql).toMatch(clause);
    }
  });

  it("declares no Prisma-level unique on Condition, which would recreate the weak index", () => {
    const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
    const model = schema.match(/model Condition \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(model).toBeTruthy();
    const declarations = model
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    // `@@unique([caseId, name])` here would have `prisma db push` rebuild the
    // case-sensitive index and drop the normalized one it cannot see.
    expect(declarations).not.toMatch(/@@unique/);
  });
});
