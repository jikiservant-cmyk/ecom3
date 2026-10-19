/**
 * ADMIN PORTAL SECURITY INVARIANTS
 *
 * The portal is the only place a human can move money or change roles, so its
 * rules are pinned here rather than trusted to memory:
 *
 *  - the browser never decides who is an admin;
 *  - a customer can never promote themselves (the DB trigger is the real gate);
 *  - role changes are still possible for the bootstrap path (SQL editor);
 *  - product photos can only be uploaded by an admin;
 *  - every privileged route authorises before it acts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const MIGRATION = read('supabase/migrations/20261020_finish_alignment.sql');
const SCHEMA = read('lib/schemaSql.ts');
const PORTAL = read('components/AdminPortal.tsx');

describe('admin identity', () => {
  it('resolves the admin role on the server, never from the browser', () => {
    // The portal signs in through our own throttled route and only trusts the
    // role that route returned.
    expect(PORTAL).toContain('signInViaServer');
    expect(PORTAL).toMatch(/result\.role\s*!==\s*"admin"/);
    expect(PORTAL).toContain('signOutUser');
  });

  it('has no offline / password-length fallback that would mint an admin', () => {
    // Strip comments: the removal of the old backdoor is documented in one, and
    // prose about a bug is not the bug.
    const code = PORTAL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/offline fallback/i);
    // The old backdoor accepted any profile whose role was admin once the typed
    // password had 4+ characters. Nothing like it may come back.
    expect(code).not.toMatch(/adminPassword\.length\s*>=?\s*4/);
  });

  it('re-checks the role on every privileged API route', () => {
    const routes: [string, string][] = [
      ['app/api/orders/route.ts', 'PATCH'],
      ['app/api/orders/refund/route.ts', 'POST'],
      ['app/api/products/route.ts', 'POST'],
    ];
    for (const [file, verb] of routes) {
      const src = read(file);
      const start = src.indexOf(`export async function ${verb}`);
      expect(start, `${file} has no ${verb}`).toBeGreaterThan(-1);
      const head = src.slice(start, start + 400);
      expect(head, `${file} ${verb} does not authorise`).toContain('authenticateAdmin');
    }
  });
});

describe('role escalation is blocked in the database, not the UI', () => {
  it('installs protect_profile_role and its trigger', () => {
    expect(MIGRATION).toContain('public.protect_profile_role()');
    expect(MIGRATION).toContain('profiles_protect_role');
    expect(MIGRATION).toMatch(/BEFORE UPDATE ON public\.profiles/);
    expect(SCHEMA).toContain('public.protect_profile_role()');
  });

  it('blocks a would-be self-promotion from a browser session', () => {
    // Any PostgREST request from a signed-in user carries auth.uid(); those are
    // the only ones that must already be admins.
    expect(MIGRATION).toMatch(/auth\.uid\(\) IS NOT NULL\s*\n\s*AND NOT public\.is_admin\(\)/);
  });

  it('still allows bootstrapping the first admin from the SQL editor', () => {
    expect(MIGRATION).toMatch(/UPDATE public\.profiles SET role = 'admin'/);
    expect(MIGRATION).toMatch(/at least one admin exists/);
  });

  it('creates a profile for every new sign-up, hard-coded to customer', () => {
    expect(MIGRATION).toContain('public.handle_new_user()');
    expect(MIGRATION).toMatch(/on_auth_user_created/);
    expect(MIGRATION).toMatch(/'customer'\s+-- hard-coded: a sign-up can never choose its own role/);
    // Existing auth users are backfilled, otherwise those customers cannot
    // check out (orders.customer_id references profiles).
    expect(MIGRATION).toMatch(/FROM auth\.users u\s*\n\s*LEFT JOIN public\.profiles p ON p\.id = u\.id/);
  });
});

describe('product photos', () => {
  it('are publicly readable but admin-only writable', () => {
    expect(MIGRATION).toMatch(/CREATE POLICY "Public read products bucket" ON storage\.objects\s+FOR SELECT/);
    expect(MIGRATION).toMatch(
      /CREATE POLICY "Admin insert products bucket" ON storage\.objects\s+FOR INSERT TO authenticated WITH CHECK \(bucket_id = 'products' AND \(SELECT public\.is_admin\(\)\)\)/
    );
    // The old public insert policy is the one that let anyone fill the bucket.
    expect(MIGRATION).toMatch(/DROP POLICY IF EXISTS "Public insert products bucket"/);
  });
});
