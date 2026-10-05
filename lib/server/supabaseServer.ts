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

/** True for values that are still .env.example placeholders. */
function isPlaceholder(value: string | undefined): boolean {
  if (!value) return true;
  return value.includes('placeholder') || value.includes('YOUR_');
}

// Fails closed AND fails loud: a verbatim copy of .env.example must not produce
// a half-configured server that silently rejects every login.
export const isServerSupabaseConfigured = Boolean(
  SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    SUPABASE_URL.startsWith('https://') &&
    !isPlaceholder(SUPABASE_URL) &&
    !isPlaceholder(SUPABASE_ANON_KEY)
);

export const hasServiceRoleKey = Boolean(SUPABASE_SERVICE_ROLE_KEY && !isPlaceholder(SUPABASE_SERVICE_ROLE_KEY));

// Clients are stateless (persistSession/autoRefreshToken are off), so they are
// safe to build once and reuse. Constructing one per request is pure overhead
// on an authentication path that runs on every privileged call.
let anonClient: SupabaseClient | null = null;
let adminClient: SupabaseClient | null = null;

/** Anon client for unprivileged server reads (RLS applies). */
export function getServerAnonClient(): SupabaseClient {
  if (!anonClient) {
    anonClient = createClient(SUPABASE_URL || 'https://placeholder.supabase.co', SUPABASE_ANON_KEY || 'placeholder', {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return anonClient;
}

/**
 * Privileged client (bypasses RLS). Only exists when SUPABASE_SERVICE_ROLE_KEY is
 * configured. Never expose to client components.
 */
export function getServerAdminClient(): SupabaseClient | null {
  if (!hasServiceRoleKey) return null;
  if (!adminClient) {
    adminClient = createClient(SUPABASE_URL as string, SUPABASE_SERVICE_ROLE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return adminClient;
}

/**
 * Supabase Auth (GoTrue) endpoint details, for server-side credential exchange.
 * Used by /api/auth/login so password sign-in can be throttled here instead of
 * going straight from the browser to Supabase.
 */
export function getSupabaseAuthConfig(): { url: string; anonKey: string } | null {
  if (!isServerSupabaseConfigured || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  return { url: SUPABASE_URL.replace(/\/+$/, ''), anonKey: SUPABASE_ANON_KEY };
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
    // The token is passed explicitly, so the shared anon client is sufficient —
    // GoTrue validates the JWT itself. Nothing here trusts the token's claims.
    const { data, error } = await getServerAnonClient().auth.getUser(token);
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
