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
 * Sign in with email and password.
 *
 * @deprecated Use {@link signInViaServer}. This calls Supabase Auth directly
 * from the browser, which bypasses the application's brute-force throttle on
 * /api/auth/login. Retained only for any remaining non-password callers.
 */
export async function signInWithEmail(email: string, password: string): Promise<{ user: User | null; session: Session | null; error: AuthError | null }> {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return { user: data.user, session: data.session, error };
  } catch (err: any) {
    return { user: null, session: null, error: err as AuthError };
  }
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
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName || email.split('@')[0],
          name: fullName || email.split('@')[0],
          phone: phone || null,
          // role deliberately omitted — the DB trigger hard-codes 'customer'
        },
      },
    });

    if (data.user) {
      try {
        await (supabase.from('profiles') as any).upsert({
          id: data.user.id,
          email: data.user.email,
          full_name: fullName || email.split('@')[0],
          phone: phone || null,
          updated_at: new Date().toISOString(),
        });
      } catch (profErr) {
        console.warn('Profile record save notice:', profErr);
      }
    }

    return { user: data.user, session: data.session, error };
  } catch (err: any) {
    return { user: null, session: null, error: err as AuthError };
  }
}

/**
 * Send Magic Link / Passwordless OTP to email
 */
export async function sendMagicLink(email: string): Promise<{ error: AuthError | null }> {
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
      },
    });
    return { error };
  } catch (err: any) {
    return { error: err as AuthError };
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
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: typeof window !== 'undefined' ? `${window.location.origin}/reset-password` : undefined,
    });
    return { error };
  } catch (err: any) {
    return { error: err as AuthError };
  }
}

/**
 * Resend signup confirmation email
 */
export async function resendSignupConfirmation(email: string): Promise<{ error: AuthError | null }> {
  try {
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: {
        emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
      },
    });
    return { error };
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

