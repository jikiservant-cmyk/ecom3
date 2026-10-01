import { NextResponse } from 'next/server';
import { isServerSupabaseConfigured, hasServiceRoleKey, getServerAnonClient } from '@/lib/server/supabaseServer';

export const dynamic = 'force-dynamic';

/**
 * Liveness/readiness endpoint for load balancers and on-call checks.
 * Returns degraded (503) when the database is unreachable so orchestrators
 * can distinguish "process alive" from "service usable".
 */
export async function GET() {
  const startedAt = Date.now();
  const checks: Record<string, unknown> = {
    supabaseConfigured: isServerSupabaseConfigured,
    serviceRoleConfigured: hasServiceRoleKey,
  };

  let healthy = true;
  if (isServerSupabaseConfigured) {
    try {
      const client = getServerAnonClient();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const { error } = await (client.from('categories') as any)
        .select('id', { count: 'exact', head: true });
      clearTimeout(timer);
      checks.database = error ? `error: ${error.message}` : 'ok';
      if (error) healthy = false;
    } catch (e: any) {
      checks.database = `exception: ${e?.message || e}`;
      healthy = false;
    }
  } else {
    checks.database = 'not configured';
    healthy = false;
  }

  return NextResponse.json(
    { status: healthy ? 'ok' : 'degraded', latencyMs: Date.now() - startedAt, checks },
    { status: healthy ? 200 : 503 }
  );
}
