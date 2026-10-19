/**
 * SCHEMA SAFETY INVARIANTS
 *
 * The live database is not what the first draft of the migration assumed:
 * `orders.status` and `payments.status` are Postgres ENUMS, not text columns
 * with CHECKs. These tests pin the rules that follow from that, because each one
 * is the difference between "the script runs" and "the store stops taking money".
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const MIGRATION = read('supabase/migrations/20261020_finish_alignment.sql');
const ENUMS = read('supabase/migrations/20261020a_enum_labels.sql');
const SCHEMA = read('lib/schemaSql.ts');

describe('enum vocabulary', () => {
  it('never writes a payment status the type does not contain', () => {
    // The enum's settled label is `paid`. 'success' is not in the type, so a
    // write of 'success' fails the settlement outright.
    expect(ENUMS).not.toMatch(/ADD VALUE IF NOT EXISTS 'success'/);
    expect(MIGRATION).not.toMatch(/status\s*=\s*'success'/);
    expect(MIGRATION).not.toMatch(/status:\s*'success'/);
    // The only place 'success' may appear is the list of LEGACY values read from
    // an older text column, which are mapped to `paid` — never written back.
    const writes = MIGRATION.match(/SET\s+status\s*=\s*'[^']+'/g) || [];
    for (const w of writes) expect(w).not.toContain('success');
    expect(SCHEMA).not.toMatch(/CHECK \(status IN \('pending', 'success'/);
  });

  it('adds enum labels in their own batch, not inside the main migration', () => {
    // A label added by ALTER TYPE cannot be used in the same transaction, and the
    // SQL editor runs a paste as one batch.
    expect(MIGRATION).not.toContain('ALTER TYPE public.order_status ADD VALUE');
    expect(ENUMS).toContain("ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'delivered'");
    expect(MIGRATION).toMatch(/20261020a_enum_labels\.sql/);
  });

  it('refuses to run before the enum has `delivered`', () => {
    expect(MIGRATION).toMatch(/has no label ''delivered''/);
  });

  it('does not put a CHECK on an enum column', () => {
    // A CHECK cannot add a label, duplicates the type, and would reject `paid`,
    // `completed` and `refunded`, which the type legitimately holds.
    expect(MIGRATION).not.toMatch(/ADD CONSTRAINT orders_status_valid/);
    expect(MIGRATION).not.toMatch(/ADD CONSTRAINT payments_status_valid/);
    expect(MIGRATION).toMatch(/DROP CONSTRAINT orders_status_valid/);
  });

  it('only rewrites existing rows when the lowercase value is a valid label', () => {
    expect(MIGRATION).toMatch(/SELECT e\.enumlabel FROM pg_enum e/);
    expect(MIGRATION).toMatch(/paid.*completed.*refunded|valid labels of/);
  });
});

describe('destructive statements', () => {
  it('never deletes webhook audit rows to satisfy DDL', () => {
    expect(MIGRATION).not.toMatch(/DELETE FROM public\.payment_webhook_events/);
    expect(MIGRATION).toMatch(/Nothing was deleted/);
  });

  it('does not drop an auth trigger that may have other responsibilities', () => {
    expect(MIGRATION).not.toMatch(/DROP TRIGGER IF EXISTS on_auth_user_created ON auth\.users/);
    expect(MIGRATION).toMatch(/already has an AFTER INSERT trigger named/);
  });
});

describe('guest idempotency', () => {
  it('scopes a guest retry to the browser session, not to every guest', () => {
    expect(MIGRATION).toContain('guest_session_id');
    expect(MIGRATION).toMatch(/idx_orders_guest_session_request_id\s*\n?\s*ON public\.orders \(guest_session_id, client_request_id\)/);
    expect(MIGRATION).not.toMatch(/COALESCE\(customer_id::text, 'guest'\)/);
  });

  it('keeps the customer-scoped index', () => {
    expect(MIGRATION).toMatch(/idx_orders_customer_request_id\s*\n?\s*ON public\.orders \(customer_id, client_request_id\)/);
    expect(MIGRATION).not.toMatch(/DROP INDEX IF EXISTS public\.idx_orders_customer_request_id/);
  });
});

describe('create_order_v2 prices from the database', () => {
  it('reads the price from product_variants and reconciles the totals', () => {
    expect(MIGRATION).toMatch(/SELECT pv\.id, pv\.price_minor_units INTO v_variant_id, v_catalog_price/);
    expect(MIGRATION).toMatch(/v_catalog_sum := v_catalog_sum \+ v_catalog_price \* item\.quantity/);
    expect(MIGRATION).toMatch(/IF v_catalog_sum <> p_subtotal_minor_units THEN/);
    expect(MIGRATION).toMatch(/line prices and discount do not reconcile/);
  });

  it('refuses a line price above the catalog price (promotions reduce, never raise)', () => {
    expect(MIGRATION).toMatch(/IF v_net_price <= 0 OR v_net_price > v_catalog_price THEN/);
  });

  it('refuses a line without a valid, active product and variant', () => {
    expect(MIGRATION).toMatch(/every line needs a valid product id/);
    expect(MIGRATION).toMatch(/product is not available/);
    expect(MIGRATION).toMatch(/selected option is not available for/);
    expect(MIGRATION).toMatch(/no active option for/);
    // No name-based product fallback: a name is neither unique nor immutable.
    expect(MIGRATION).not.toMatch(/WHERE p\.name = item\."productName" AND p\.status = 'active'/);
  });

  it('is executable only by the service role', () => {
    expect(MIGRATION).toMatch(/create_order_v2 is server-only/);
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.create_order_v2\([^)]*TIMESTAMPTZ, TEXT\) FROM PUBLIC, anon, authenticated/);
  });
});

describe('policies', () => {
  it('leaves no public write path on the catalog', () => {
    expect(MIGRATION).toMatch(/FOREACH t IN ARRAY ARRAY\['products','product_variants','product_images','categories'\]/);
    expect(MIGRATION).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public\.%I FROM anon, authenticated/);
    expect(MIGRATION).toMatch(/CREATE POLICY "Products admin write" ON public\.products FOR ALL TO authenticated/);
  });

  it('gives the browser no access to the webhook ledger', () => {
    expect(MIGRATION).toMatch(/REVOKE ALL ON public\.payment_webhook_events FROM anon, authenticated/);
  });

  it('does not publish reviewer email addresses', () => {
    expect(MIGRATION).toMatch(
      /GRANT SELECT \(id, product_id, user_name, rating, comment, verified_purchase, created_at\)\s*\n\s*ON public\.reviews TO anon, authenticated/
    );
    expect(SCHEMA).toContain('GRANT SELECT (id, product_id, user_name, rating, comment, verified_purchase, created_at)');
  });
});
