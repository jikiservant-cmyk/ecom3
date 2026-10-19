#!/usr/bin/env node
/**
 * Parse every SQL file in the repo with libpg_query (the real PostgreSQL
 * grammar, via `pgsql-parser`).
 *
 *   node tools/sql-lint.mjs
 *
 * Catches the mistake that is otherwise invisible until you paste a migration
 * into the Supabase editor: a syntax error half way down a 600-line file, which
 * aborts the whole transaction.
 *
 * It also parses the big SQL template exported by `lib/schemaSql.ts`, which is
 * never fed to a compiler — a stray backtick or a malformed DO block there would
 * only surface in production.
 *
 * This checks SYNTAX, not semantics: it cannot know whether a column exists or
 * whether a policy would grant too much.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const files = [];

const migDir = join(ROOT, 'supabase/migrations');
try {
  for (const f of readdirSync(migDir)) if (f.endsWith('.sql')) files.push({ path: join(migDir, f), name: f });
} catch {
  /* no migrations directory */
}

// The schema shipped to the Admin Portal lives in a TS template literal.
const schemaTs = readFileSync(join(ROOT, 'lib/schemaSql.ts'), 'utf8');
const start = schemaTs.indexOf('`');
const end = schemaTs.lastIndexOf('`');
if (start === -1 || end <= start) {
  console.error('Could not locate the SQL template in lib/schemaSql.ts');
  process.exit(2);
}
files.push({ name: 'lib/schemaSql.ts (embedded SQL)', sql: schemaTs.slice(start + 1, end) });

const { parse } = await import('pgsql-parser');

let failed = 0;
for (const file of files) {
  const sql = file.sql ?? readFileSync(file.path, 'utf8');
  try {
    const ast = await parse(sql);
    console.log(`OK    ${file.name.padEnd(48)} ${String(ast.stmts.length).padStart(4)} statements`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${file.name}`);
    const line = /at or near "([^"]+)"/.exec(e.message);
    if (line) console.log(`      near: ${line[1]}`);
    console.log('      ' + String(e.message).split('\n')[0].slice(0, 200));
  }
}

if (failed > 0) {
  console.log(`\n${failed} file(s) contain SQL that PostgreSQL will not parse.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} SQL sources parse cleanly.`);
