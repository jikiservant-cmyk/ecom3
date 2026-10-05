import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, getServerAdminClient } from '@/lib/server/supabaseServer';
import { logger } from '@/lib/server/logging';
import { readJsonBody, isNonEmptyString, isIntInRange, sanitizeText, jsonError } from '@/lib/server/validation';

export const dynamic = 'force-dynamic';

/** Public read of reviews, optionally filtered by product. */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const productId = searchParams.get('productId');
    const client = getServerAdminClient();
    if (!client) return jsonError('Reviews are not configured', 503);

    let query = (client.from('reviews') as any)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (productId) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(productId)) return jsonError('Invalid productId', 400);
      query = query.eq('product_id', productId);
    }
    const { data, error } = await query;
    if (error) {
      logger.error('reviews_list_error', { error: error.message });
      return jsonError('Failed to fetch reviews', 500);
    }
    const reviews = (data || []).map((r: any) => ({
      id: r.id,
      productId: r.product_id,
      userName: r.user_name,
      rating: Number(r.rating) || 5,
      comment: r.comment || '',
      createdAt: r.created_at,
      // Never expose reviewers' emails; verified flag comes only from the DB.
      verifiedPurchase: Boolean(r.verified_purchase),
    }));
    return NextResponse.json({ success: true, count: reviews.length, reviews });
  } catch (e: any) {
    logger.error('reviews_list_exception', { error: e?.message });
    return jsonError('Failed to fetch reviews', 500);
  }
}

/**
 * Submit a review — requires a valid account.
 * `verifiedPurchase` is FORCED server-side from actual order history; the client
 * value is ignored to stop fake "verified" badges.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth) return jsonError('Please sign in to submit a review', 401);

  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  if (!isNonEmptyString(body.productId, 64)) return jsonError('A valid productId is required', 400);
  if (!isIntInRange(body.rating, 1, 5)) return jsonError('Rating must be between 1 and 5', 400);
  if (!isNonEmptyString(body.comment, 2000)) return jsonError('Please write a short review', 400);

  try {
    const client = getServerAdminClient();
    if (!client) return jsonError('Reviews are not configured', 503);

    // The reviewed product must exist — previously a review could be attached
    // to any arbitrary productId string.
    const { data: product } = await (client.from('products') as any)
      .select('id, name')
      .eq('id', body.productId)
      .maybeSingle();
    if (!product) return jsonError('Product not found', 404);

    // Verified = THIS reviewer has a non-cancelled order containing THIS
    // product. The old check passed if the user had any order at all and anyone
    // anywhere had bought the product, which made the badge trivially inflatable.
    let verifiedPurchase = false;
    const { data: ownOrders } = await (client.from('orders') as any)
      .select('id')
      .eq('customer_id', auth.userId)
      .neq('status', 'Cancelled')
      .limit(500);
    const ownOrderIds = (ownOrders || []).map((o: any) => o?.id).filter(Boolean);
    if (ownOrderIds.length > 0) {
      const { count } = await (client.from('order_items') as any)
        .select('id', { count: 'exact', head: true })
        .in('order_id', ownOrderIds)
        .ilike('product_name', `%${product.name.replace(/[%,_]/g, '')}%`);
      verifiedPurchase = Boolean(count && count > 0);
    }

    const { error } = await (client.from('reviews') as any).insert({
      product_id: body.productId,
      user_name: auth.email ? auth.email.split('@')[0] : 'Member',
      user_email: null, // do not persist reviewer email
      rating: body.rating,
      comment: sanitizeText(body.comment, 2000),
      verified_purchase: verifiedPurchase,
      created_at: new Date().toISOString(),
    });
    if (error) {
      logger.error('review_insert_error', { error: error.message });
      return jsonError('Could not submit your review right now', 500);
    }
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (e: any) {
    logger.error('review_insert_exception', { error: e?.message });
    return jsonError('Could not submit your review right now', 500);
  }
}
