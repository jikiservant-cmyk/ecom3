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
 * Sign in with email and password
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

