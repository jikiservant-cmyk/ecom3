import { NextResponse } from 'next/server';
import {
  getServerAdminClient,
  getServerAnonClient,
  getSupabaseProjectRef,
  hasServiceRoleKey,
  isServerSupabaseConfigured,
} from '@/lib/server/supabaseServer';

export const dynamic = 'force-dynamic';

/**
 * Liveness/readiness endpoint for load balancers and on-call checks.
 * Verifies both the public database read and the server-only credential used
 * by checkout, so a healthy anon client cannot mask a broken order writer.
 */
export async function GET() {
  const startedAt = Date.now();
  const checks: Record<string, unknown> = {
    supabaseConfigured: isServerSupabaseConfigured,
    supabaseProjectRef: getSupabaseProjectRef() || 'unknown',
    serviceRoleConfigured: hasServiceRoleKey,
    orderWriteReady: isServerSupabaseConfigured && hasServiceRoleKey,
  };

  let healthy = isServerSupabaseConfigured && hasServiceRoleKey;

  if (isServerSupabaseConfigured) {
    try {
      const { error } = await getServerAnonClient()
        .from('categories')
        .select('id', { count: 'exact', head: true });
      checks.database = error ? `error:${error.code || 'unknown'}` : 'ok';
      if (error) healthy = false;
    } catch {
      checks.database = 'exception';
      healthy = false;
    }
  } else {
    checks.database = 'not configured';
    healthy = false;
  }

  if (hasServiceRoleKey) {
    try {
      const adminClient = getServerAdminClient();
      if (!adminClient) {
        checks.serviceRoleDatabase = 'not configured';
        healthy = false;
      } else {
        const { error } = await adminClient
          .from('categories')
          .select('id', { count: 'exact', head: true });
        checks.serviceRoleDatabase = error ? `error:${error.code || 'unknown'}` : 'ok';
        if (error) healthy = false;
      }
    } catch {
      checks.serviceRoleDatabase = 'exception';
      healthy = false;
    }
  } else {
    checks.serviceRoleDatabase = 'not configured';
    healthy = false;
  }

  return NextResponse.json(
    { status: healthy ? 'ok' : 'degraded', latencyMs: Date.now() - startedAt, checks },
    { status: healthy ? 200 : 503 }
  );
}
