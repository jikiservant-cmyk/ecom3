import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, getServerAdminClient } from '@/lib/server/supabaseServer';
import { logger } from '@/lib/server/logging';
import { readJsonBody, isIntInRange, isNonEmptyString, sanitizeText, jsonError } from '@/lib/server/validation';

export const dynamic = 'force-dynamic';

/**
 * Store ratings — customers rate the shop itself, not a single product.
 *
 * Only someone who has actually PAID for an order may rate, and only one rating
 * per customer (they can change it, not spam it). The gate is enforced here and
 * again by a database trigger, so it holds even against a direct PostgREST
 * insert.
 */

/** Public read: every rating plus the average, for the storefront badge. */
export async function GET() {
  try {
    const client = getServerAdminClient();
    if (!client) return jsonError('Ratings are not configured', 503);

    const { data, error } = await (client.from('store_ratings') as any)
      .select('id, user_name, rating, comment, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      logger.error('store_rating_list_error', { error: error.message });
      return jsonError('Failed to fetch ratings', 500);
    }

    const ratings = (data || []).map((r: any) => ({
      id: r.id,
      userName: r.user_name,
      rating: Number(r.rating) || 0,
      comment: r.comment || '',
      createdAt: r.created_at,
    }));
    const total = ratings.reduce((sum: number, r: any) => sum + r.rating, 0);
    return NextResponse.json({
      success: true,
      count: ratings.length,
      average: ratings.length > 0 ? Math.round((total / ratings.length) * 10) / 10 : 0,
      ratings,
    });
  } catch (e: any) {
    logger.error('store_rating_list_exception', { error: e?.message });
    return jsonError('Failed to fetch ratings', 500);
  }
}

/**
 * Submit or update the signed-in customer's store rating. Upserts so a customer
 * can revise their score without inflating the average.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth) return jsonError('Please sign in to rate the store', 401);

  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  if (!isIntInRange(body.rating, 1, 5)) return jsonError('Rating must be between 1 and 5', 400);
  // A comment is optional here (unlike product reviews) — a star score alone is
  // a legitimate rating of the shop.
  const comment = isNonEmptyString(body.comment, 2000) ? sanitizeText(body.comment, 2000) : '';

  try {
    const client = getServerAdminClient();
    if (!client) return jsonError('Ratings are not configured', 503);

    // Eligibility: at least one order that was actually paid. Checked here so we
    // can return a helpful message; the DB trigger enforces it regardless.
    const { count: paidCount } = await (client.from('orders') as any)
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', auth.userId)
      .eq('payment_status', 'Paid');

    if (!paidCount || paidCount === 0) {
      return jsonError(
        'You can rate the store once one of your orders has been paid. Complete a purchase and come back!',
        403
      );
    }

    // Display name from the profile. Never derived from the email: this list is
    // publicly readable and an email local-part is PII.
    let displayName = 'Drum Palace Customer';
    try {
      const { data: profile } = await (client.from('profiles') as any)
        .select('full_name')
        .eq('id', auth.userId)
        .maybeSingle();
      const fullName = typeof profile?.full_name === 'string' ? profile.full_name.trim() : '';
      if (fullName && !fullName.includes('@')) displayName = sanitizeText(fullName, 80) || displayName;
    } catch {
      // Keep the generic label rather than failing the rating.
    }

    const now = new Date().toISOString();
    const { error } = await (client.from('store_ratings') as any).upsert(
      {
        user_id: auth.userId,
        user_name: displayName,
        rating: body.rating,
        comment,
        created_at: now,
      },
      { onConflict: 'user_id' }
    );
    if (error) {
      logger.error('store_rating_upsert_error', { error: error.message });
      return jsonError('Could not save your rating right now', 500);
    }

    logger.info('store_rating_saved', { userId: auth.userId, rating: body.rating });
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (e: any) {
    logger.error('store_rating_upsert_exception', { error: e?.message });
    return jsonError('Could not save your rating right now', 500);
  }
}
