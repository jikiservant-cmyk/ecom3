#!/usr/bin/env node
/**
 * Schema drift checker: does the application code reference columns the
 * database schema actually defines?
 *
 *   node tools/schema-drift.mjs            # report
 *   node tools/schema-drift.mjs --strict   # exit 1 on any unknown column
 *
 * It parses `lib/schemaSql.ts` (the canonical schema that ships with the app)
 * and cross-checks every column the code names in PostgREST calls:
 *
 *   .from('orders').select('id, order_number, …').eq('id', …)
 *
 * This catches the class of bug that only shows up in production: a route that
 * selects `orders.customer_email` after someone renamed it, or a new column
 * added in code but never added to the schema (silently dropped, because
 * `CREATE TABLE IF NOT EXISTS` does not alter an existing table).
 *
 * It is a static check — it cannot see a live database. Applying the schema to
 * a staging project and running the app against it is still required.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const SCHEMA_FILE = join(ROOT, 'lib/schemaSql.ts');
const STRICT = process.argv.includes('--strict');
const EMIT_SQL = process.argv.includes('--emit-sql');

const schemaSrc = readFileSync(SCHEMA_FILE, 'utf8');

// ── Parse the schema ────────────────────────────────────────────────────────
/** @type {Map<string, Set<string>>} table → columns */
const tables = new Map();
/** @type {Map<string, Set<string>>} table → unique indexes / constraints */
const unique = new Map();
/** @type {{name:string, table:string}[]} */
const constraints = [];

/** @type {Map<string, string[]>} RPC name → parameter names */
const rpcParams = new Map();

/**
 * Parse a PostgREST select string into {table, column} pairs.
 *
 *   'id, order_items ( quantity, unit_price_minor_units )'
 *      → orders.id, order_items.quantity, order_items.unit_price_minor_units
 *
 * Handles `alias:relation(...)`, `relation!inner(...)`, `relation!fk(...)`,
 * `count`, `*` and function calls (`count(*)`).
 */
function parseSelect(text, baseTable) {
  const out = [];
  let buf = '';
  const stack = [{ table: baseTable, alias: null }];
  const flush = () => {
    let token = buf.trim();
    buf = '';
    if (!token || token === '*') return;
    token = token.replace(/^[a-z_][a-z0-9_]*:/i, ''); // alias:col
    token = token.replace(/^[a-z_][a-z0-9_]*\./i, ''); // table.col
    if (/^\d+$/.test(token) || /^(asc|desc|nulls|first|last)$/i.test(token)) return;
    if (!/^[a-z_][a-z0-9_]*$/i.test(token)) return; // cast syntax, json paths, ::
    out.push({ table: stack[stack.length - 1].alias || stack[stack.length - 1].table, column: token });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      const head = buf.trim();
      buf = '';
      const rel = head
        .replace(/^[a-z_][a-z0-9_]*:/i, '') // alias:
        .replace(/!.*$/, '') // !inner / !fk
        .trim();
      const aliasMatch = /^([a-z_][a-z0-9_]*):/i.exec(head);
      stack.push({ table: rel || baseTable, alias: aliasMatch ? rel : null });
      continue;
    }
    if (ch === ')') {
      flush();
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (ch === ',') {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

/** @type {string[]} RPC signatures */
const functions = [];

function noteUnique(table, text) {
  if (!unique.has(table)) unique.set(table, new Set());
  unique.get(table).add(text.trim().replace(/\s+/g, ' '));
}

for (const m of schemaSrc.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const [, table, body] = m;
  const cols = new Set();
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('--')) continue;
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE)\b/i.test(line)) {
      if (/^UNIQUE\s*\(/i.test(line)) noteUnique(table, line);
      continue;
    }
    const col = /^([a-z_][a-z0-9_]*)\s+/i.exec(line);
    if (col) cols.add(col[1]);
  }
  tables.set(table, cols);
}

for (const m of schemaSrc.matchAll(/ALTER TABLE public\.(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)/g)) {
  const [, table, col] = m;
  if (!tables.has(table)) tables.set(table, new Set());
  tables.get(table).add(col);
}

for (const m of schemaSrc.matchAll(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)?\s+(\w+)\s+ON\s+public\.(\w+)\s*\(([^)]*)\)/g)) {
  const [, name, table, cols] = m;
  const isUnique = /^CREATE UNIQUE/i.test(m[0]);
  if (isUnique) noteUnique(table, `${name} (${cols.trim()})`);
}

const indexNames = [];
for (const m of schemaSrc.matchAll(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)?\s+(\w+)\s+ON\s+public\.(\w+)/g)) {
  indexNames.push({ name: m[1], table: m[2] });
}

for (const m of schemaSrc.matchAll(/ADD CONSTRAINT\s+(\w+)/g)) {
  constraints.push({ name: m[1], table: '(see schema)' });
}
for (const m of schemaSrc.matchAll(/CONSTRAINT\s+(\w+)\s+UNIQUE/g)) {
  constraints.push({ name: m[1], table: '(see schema)' });
}

for (const m of schemaSrc.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\s*\(([\s\S]*?)\)\s*RETURNS/g)) {
  functions.push(`${m[1]}(${m[2].split('\n').map((l) => l.trim()).filter(Boolean).join(' ')})`);
  const params = m[2]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.match(/^(\w+)\s+/) || [])[1])
    .filter(Boolean);
  rpcParams.set(m[1], params);
}

// ── Collect code references ────────────────────────────────────────────────
const CODE_DIRS = ['app', 'lib', 'components'];
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (['.ts', '.tsx'].includes(extname(p)) && !p.endsWith('.test.ts')) files.push(p);
  }
}
for (const d of CODE_DIRS) walk(join(ROOT, d));

/** @type {{file:string, table:string, column:string, kind:string}[]} */
const refs = [];
/** @type {{file:string, name:string, args:string[]}[]} */
const rpcCalls = [];

/**
 * Keys of an object literal at depth 1 only — nested payload keys (e.g. the
 * `productName` inside `p_items`) must not look like function parameters.
 */
function topLevelKeys(body) {
  // Strip line comments so prose like `// SECURITY: ...` is not read as a key.
  body = body.replace(/\/\/[^\n]*/g, '');
  const keys = [];
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (depth === 0) {
      const m = /^([A-Za-z_]\w*)\s*:/.exec(body.slice(i));
      // A key starts a property: at the beginning, or after `{` / `,` (not
      // after `?` or `:` — those are ternaries like `settled_at: paid ? now : null`).
      const prev = body.slice(0, i).replace(/\s+$/, '').slice(-1);
      if (m && (prev === '' || prev === '{' || prev === ',')) {
        keys.push(m[1]);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return keys;
}

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  // Every `.from('table')` opens a scope that ends at the next `.from(`.
  // RPC calls are not tied to a `.from()` scope — scan the whole file for them.
  // Handles `client.rpc(...)` and the cast form `(client.rpc as any)(...)`.
  // The argument object is extracted by BALANCED braces — a regex cannot handle
  // nested payloads like `p_items: input.items.map(it => ({ ... }))`.
  for (const m of src.matchAll(/rpc(?:\s+as\s+any)?\)?\s*\(\s*['"](\w+)['"]\s*,\s*/g)) {
    const bodyStart = src.indexOf('{', m.index + m[0].length);
    if (bodyStart === -1) continue;
    let depth = 0;
    let end = bodyStart;
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    rpcCalls.push({ file, name: m[1], args: topLevelKeys(src.slice(bodyStart + 1, end)) });
  }

  const froms = [...src.matchAll(/\.from\(\s*['"](\w+)['"]\s*\)/g)];
  froms.forEach((from, i) => {
    const table = from[1];
    const start = from.index;
    const end = i + 1 < froms.length ? froms[i + 1].index : Math.min(src.length, start + 4000);
    const chunk = src.slice(start, end);

    // select('a, b, nested (x, y)') — nested columns belong to the nested table.
    for (const sel of chunk.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1(?:\s*,\s*\{[^{}]*\})?\s*\)/g)) {
      for (const ref of parseSelect(sel[2], table)) {
        refs.push({ file, table: ref.table, column: ref.column, kind: 'select' });
      }
    }

    // Writes: keys of the object literal handed to insert()/update()/upsert().
    // A typo here is a runtime error in production, so it is worth checking.
    for (const write of chunk.matchAll(/\.(insert|upsert|update)\(\s*\{/g)) {
      const braceStart = chunk.indexOf('{', write.index + write[0].length - 1);
      let depth = 0;
      let end = braceStart;
      for (; end < chunk.length; end++) {
        if (chunk[end] === '{') depth++;
        else if (chunk[end] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      for (const key of topLevelKeys(chunk.slice(braceStart + 1, end))) {
        refs.push({ file, table, column: key, kind: `.${write[1]}()` });
      }
    }

    for (const eq of chunk.matchAll(/\.(eq|in|is|order|filter)\(\s*['"]([^'"]+)['"]/g)) {
      const column = eq[2];
      if (!/^[a-z_][a-z0-9_]*$/i.test(column)) continue; // skip json paths like raw_payload->>x
      refs.push({ file, table, column, kind: `.${eq[1]}()` });
    }
  });
}

// ── Report ─────────────────────────────────────────────────────────────────
const unknown = new Map(); // "table.column" → {table, column, kinds:Set, files:Set}
const knownTables = new Set(tables.keys());

for (const r of refs) {
  if (!knownTables.has(r.table)) {
    const key = `MISSING TABLE public.${r.table}`;
    if (!unknown.has(key)) unknown.set(key, { table: r.table, column: '*', kinds: new Set(), files: new Set() });
    unknown.get(key).kinds.add(r.kind);
    unknown.get(key).files.add(r.file.replace(ROOT + '/', ''));
    continue;
  }
  if (tables.get(r.table).has(r.column)) continue;
  const key = `public.${r.table}.${r.column}`;
  if (!unknown.has(key)) unknown.set(key, { table: r.table, column: r.column, kinds: new Set(), files: new Set() });
  unknown.get(key).kinds.add(r.kind);
  unknown.get(key).files.add(r.file.replace(ROOT + '/', ''));
}

if (EMIT_SQL) {
  // A runnable checklist for a LIVE database. Paste into the Supabase SQL
  // editor: every row says OK or MISSING, so drift is visible without reading
  // the schema by hand.
  const rows = [];
  const seen = new Set();
  const push = (line) => { if (!seen.has(line)) { seen.add(line); rows.push(line); } };
  for (const [table, cols] of tables) {
    for (const col of cols) push(`    ('table column', 'public.${table}.${col}')`);
  }
  for (const f of functions) {
    const name = f.slice(0, f.indexOf('('));
    push(`    ('function', 'public.${name}')`);
  }
  for (const idx of indexNames) push(`    ('index', '${idx.name}')`);
  for (const c of constraints) push(`    ('constraint', '${c.name}')`);

  const sql = `-- Generated by tools/schema-drift.mjs --emit-sql. Do not edit by hand.
-- Run in the Supabase SQL editor. Every row reports OK or MISSING.
WITH expected(kind, object_name) AS (
  VALUES
${rows.join(',\n')}
)
SELECT
  e.kind,
  e.object_name,
  CASE
    WHEN e.kind = 'table column' THEN
      CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = split_part(e.object_name, '.', 1)
          AND c.table_name = split_part(split_part(e.object_name, '.', 2), '.', 1)
          AND c.column_name = split_part(e.object_name, '.', 3)
      ) THEN 'OK' ELSE 'MISSING' END
    WHEN e.kind = 'function' THEN
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = split_part(e.object_name, '.', 1)
          AND p.proname = split_part(e.object_name, '.', 2)
      ) THEN 'OK' ELSE 'MISSING' END
    WHEN e.kind = 'index' THEN
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_indexes i WHERE i.indexname = e.object_name
      ) THEN 'OK' ELSE 'MISSING' END
    WHEN e.kind = 'constraint' THEN
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_constraint k WHERE k.conname = e.object_name
      ) THEN 'OK' ELSE 'MISSING' END
  END AS status
FROM expected e
ORDER BY status DESC, e.kind, e.object_name;
`;
  process.stdout.write(sql);
  process.exit(0);
}

console.log('Schema drift report');
console.log(`  schema:  lib/schemaSql.ts — ${tables.size} tables, ${functions.length} functions`);
console.log(`  code:    ${files.length} files, ${refs.length} column references\n`);

console.log('Tables defined:');
for (const [t, cols] of [...tables].sort()) {
  const uq = unique.get(t);
  console.log(`  ${t.padEnd(24)} ${String(cols.size).padStart(2)} cols${uq ? `  unique: ${[...uq].join('; ')}` : ''}`);
}

console.log('\nFunctions:');
for (const f of functions) console.log(`  ${f.slice(0, 110)}`);

if (unknown.size === 0) {
  console.log('\nNo unknown columns referenced by the code.');
} else {
  console.log(`\n${unknown.size} column(s) referenced by code but NOT defined in the schema:`);
  for (const [key, info] of [...unknown].sort()) {
    console.log(`  ✗ ${key}`);
    console.log(`      via ${[...info.kinds].join(', ')}`);
    console.log(`      in  ${[...info.files].join(', ')}`);
  }
}

// ── RPC argument parity ──────────────────────────────────────────────────
const rpcProblems = [];
for (const call of rpcCalls) {
  const expected = rpcParams.get(call.name);
  if (!expected) {
    rpcProblems.push(`RPC public.${call.name} is called but not defined (${call.file})`);
    continue;
  }
  const missing = expected.filter((p) => !call.args.includes(p));
  const extra = call.args.filter((a) => !expected.includes(a));
  if (missing.length || extra.length) {
    rpcProblems.push(
      `RPC public.${call.name} (${call.file}): missing args [${missing.join(', ')}] / unknown args [${extra.join(', ')}]`
    );
  }
}
if (rpcCalls.length > 0) {
  console.log(`\nRPC calls: ${rpcCalls.length}`);
  for (const call of rpcCalls) console.log(`  ${call.name}(${call.args.join(', ')})  ← ${call.file.replace(ROOT + '/', '')}`);
  console.log(rpcProblems.length ? '\nRPC argument mismatches:' : '\nAll RPC calls match a defined function signature.');
  for (const p of rpcProblems) console.log(`  ✗ ${p}`);
}

// Columns the schema defines but code never mentions — usually fine (audit
// columns, future fields), printed for completeness.
const mentioned = new Set(refs.map((r) => `${r.table}.${r.column}`));
const unmentioned = [];
for (const [t, cols] of tables) {
  for (const c of cols) if (!mentioned.has(`${t}.${c}`)) unmentioned.push(`${t}.${c}`);
}
console.log(`\nDefined but never referenced in app code (${unmentioned.length}):`);
console.log('  ' + unmentioned.sort().join(', '));

if (STRICT && (unknown.size > 0 || rpcProblems.length > 0)) process.exit(1);
