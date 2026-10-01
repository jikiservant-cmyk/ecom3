import { NextRequest, NextResponse } from 'next/server';
import { authenticateAdmin } from '@/lib/server/supabaseServer';
import { getProductsFromDb, getCategoriesFromDb, saveProductToDb, seedInitialDataToSupabase } from '@/lib/supabaseDb';
import { logger } from '@/lib/server/logging';
import { readJsonBody, jsonError } from '@/lib/server/validation';

export const dynamic = 'force-dynamic';

/** Public catalog read. */
export async function GET() {
  try {
    const products = await getProductsFromDb();
    const categories = await getCategoriesFromDb();
    return NextResponse.json({
      success: true,
      count: products.length,
      categoriesCount: categories.length,
      products,
      categories,
    });
  } catch (e: any) {
    logger.error('products_get_error', { error: e?.message });
    return jsonError('Failed to fetch products', 500);
  }
}

/** Catalog writes (create/update/seed) — admin only. */
export async function POST(req: NextRequest) {
  const admin = await authenticateAdmin(req);
  if (!admin) return jsonError('Authentication required', 401);

  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  try {
    if (body.action === 'seed') {
      const result = await seedInitialDataToSupabase();
      logger.info('catalog_seed', { admin: admin.userId, result: result.message });
      return NextResponse.json(result);
    }

    if (body.product && typeof body.product === 'object') {
      const result = await saveProductToDb(body.product);
      if (!result.success) return jsonError(result.error || 'Failed to save product', 400);
      logger.info('product_saved', { admin: admin.userId, productId: body.product.id });
      return NextResponse.json(result);
    }

    return jsonError('Invalid payload. Provide product object or action: "seed"', 400);
  } catch (e: any) {
    logger.error('products_post_error', { error: e?.message });
    return jsonError('Failed to process product request', 500);
  }
}
