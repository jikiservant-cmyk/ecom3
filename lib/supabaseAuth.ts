import { supabase } from './supabase';
import { User, Session, AuthError } from '@supabase/supabase-js';

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
  role?: string;
}

/**
 * Sign in through our own API route so the attempt is throttled server-side
 * (per IP and per account). The route exchanges the credentials with Supabase
 * GoTrue, looks up the authoritative role from `profiles`, and returns a
 * session which we install here — so RLS and the rest of the app behave exactly
 * as they did with a browser-side sign-in.
 */
export async function signInViaServer(
  email: string,
  password: string
): Promise<{ user: User | null; session: Session | null; role: 'admin' | 'customer'; name: string; phone?: string; error: string | null }> {
  const denied = (error: string) => ({ user: null, session: null, role: 'customer' as const, name: '', error });
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success || !data?.session?.access_token || !data?.session?.refresh_token) {
      return denied(data?.error || 'Invalid email or password.');
    }

    const { data: installed, error } = await supabase.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    if (error || !installed?.user) {
      return denied(error?.message || 'Could not start your session. Please try again.');
    }

    return {
      user: installed.user,
      session: installed.session,
      role: data.role === 'admin' ? 'admin' : 'customer',
      name: typeof data.user?.name === 'string' ? data.user.name : '',
      phone: typeof data.user?.phone === 'string' ? data.user.phone : undefined,
      error: null,
    };
  } catch (err: any) {
    return denied(err?.message || 'Sign-in is currently unavailable. Please try again.');
  }
}

/**
 * Sign up with email, password, and optional full name / phone.
 *
 * SECURITY: new accounts are ALWAYS customers. The previous version accepted a
 * client-supplied role which let anyone self-assign 'admin' at signup. Admins
 * are provisioned directly in the database by an existing operator.
 */
export async function signUpWithEmail(
  email: string,
  password: string,
  fullName?: string,
  phone?: string
): Promise<{ user: User | null; session: Session | null; error: AuthError | null }> {
  try {
    // Registration goes through our API so it is throttled server-side, and so
    // the browser never writes to `profiles` directly (the `handle_new_user()`
    // trigger creates the row with role 'customer').
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, fullName, phone }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) {
      return { user: null, session: null, error: new Error(data?.error || 'Could not create your account.') as unknown as AuthError };
    }

    // Email confirmation required — no session to install yet.
    if (data.needsConfirmation || !data.session?.access_token || !data.session?.refresh_token) {
      return { user: null, session: null, error: null };
    }

    const { data: installed, error } = await supabase.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    if (error || !installed?.user) {
      return { user: null, session: null, error: (error || new Error('Could not start your session.')) as unknown as AuthError };
    }
    return { user: installed.user, session: installed.session, error: null };
  } catch (err: any) {
    return { user: null, session: null, error: err as AuthError };
  }
}

/**
 * Sign in with third-party OAuth provider (Google, GitHub)
 */
export async function signInWithOAuth(provider: 'google' | 'github'): Promise<{ error: AuthError | null }> {
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
      },
    });
    return { error };
  } catch (err: any) {
    return { error: err as AuthError };
  }
}

/**
 * Send password reset email
 */
export async function resetPassword(email: string): Promise<{ error: AuthError | null }> {
  try {
    // Through our API so the reset is throttled per account and per IP. An
    // unthrottled reset endpoint lets anyone mail-bomb an admin address and
    // burn the project's auth quota.
    const res = await fetch('/api/auth/password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { error: new Error(data?.error || 'Could not send the reset link. Please try again later.') as unknown as AuthError };
    }
    return { error: null };
  } catch (err: any) {
    return { error: err as AuthError };
  }
}

/**
 * Sign out the current user
 */
export async function signOutUser(): Promise<{ error: AuthError | null }> {
  try {
    const { error } = await supabase.auth.signOut();
    return { error };
  } catch (err: any) {
    return { error: err as AuthError };
  }
}

/**
 * Get the current active session
 */
export async function getCurrentSession(): Promise<Session | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session;
  } catch (err) {
    console.warn('Get session error:', err);
    return null;
  }
}

/**
 * Fetch profile details including role ('admin', 'customer') from public.profiles
 */
export async function fetchUserProfile(userId: string): Promise<{ name: string; role: 'admin' | 'customer'; phone?: string } | null> {
  try {
    const { data, error } = await (supabase.from('profiles') as any)
      .select('id, full_name, phone, role')
      .eq('id', userId)
      .single();

    if (!error && data) {
      return {
        name: data.full_name || '',
        phone: data.phone || '',
        role: data.role === 'admin' ? 'admin' : 'customer',
      };
    }
  } catch (err) {
    console.warn('Fetch user profile error:', err);
  }
  return null;
}

