/**
 * Server-side Supabase clients and request-scoped auth helpers.
 *
 * Security model:
 * - The public anon key is NEVER trusted for privileged operations on the server.
 * - If SUPABASE_SERVICE_ROLE_KEY is configured, privileged server paths (webhooks,
 *   order writes) use it; it bypasses RLS and must stay server-side only.
 * - User identity is verified against Supabase Auth via the bearer token on each
 *   request (auth.getUser), never via client-supplied fields.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const isServerSupabaseConfigured = Boolean(
  SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    SUPABASE_URL.startsWith('https://') &&
    !SUPABASE_URL.includes('placeholder') &&
    !SUPABASE_ANON_KEY.includes('placeholder')
);

export const hasServiceRoleKey = Boolean(
  SUPABASE_SERVICE_ROLE_KEY && !SUPABASE_SERVICE_ROLE_KEY.includes('YOUR_')
);

/** Anon client for unprivileged server reads (RLS applies). */
export function getServerAnonClient(): SupabaseClient {
  return createClient(SUPABASE_URL || 'https://placeholder.supabase.co', SUPABASE_ANON_KEY || 'placeholder', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Privileged client (bypasses RLS). Only exists when SUPABASE_SERVICE_ROLE_KEY is
 * configured. Never expose to client components.
 */
export function getServerAdminClient(): SupabaseClient | null {
  if (!hasServiceRoleKey) return null;
  return createClient(SUPABASE_URL as string, SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Client acting as the requesting user (their JWT, RLS applies to them). */
export function getUserScopedClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL || 'https://placeholder.supabase.co', SUPABASE_ANON_KEY || 'placeholder', {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface AuthenticatedRequest {
  userId: string;
  email: string | null;
  accessToken: string;
}

/** Extract the bearer token from a request, if present and well-formed. */
export function extractBearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  // Supabase JWTs are three dot-separated base64url segments.
  if (!token || token.split('.').length !== 3) return null;
  return token;
}

/**
 * Verify the request's bearer token against Supabase Auth.
 * Returns null when missing/invalid — callers decide the status code.
 */
export async function authenticateRequest(req: Request): Promise<AuthenticatedRequest | null> {
  if (!isServerSupabaseConfigured) return null;
  const token = extractBearerToken(req);
  if (!token) return null;
  try {
    const client = getUserScopedClient(token);
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user) return null;
    return { userId: data.user.id, email: data.user.email ?? null, accessToken: token };
  } catch {
    return null;
  }
}

export interface AdminIdentity extends AuthenticatedRequest {
  name: string;
}

/**
 * Verify the requester is an admin: valid session AND profiles.role = 'admin'.
 * The role is read server-side from the database, never from the token or body.
 */
export async function authenticateAdmin(req: Request): Promise<AdminIdentity | null> {
  const auth = await authenticateRequest(req);
  if (!auth) return null;
  try {
    const client = getUserScopedClient(auth.accessToken);
    const { data, error } = await (client.from('profiles') as any)
      .select('full_name, role')
      .eq('id', auth.userId)
      .maybeSingle();
    if (error || !data || data.role !== 'admin') return null;
    return { ...auth, name: data.full_name || 'Administrator' };
  } catch {
    return null;
  }
}
