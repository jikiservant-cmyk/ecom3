import { NextRequest, NextResponse } from 'next/server';
import { authenticateAdmin, getServerAdminClient } from '@/lib/server/supabaseServer';
import { getCategoriesFromDb, slugifyCategoryName } from '@/lib/supabaseDb';
import { logger } from '@/lib/server/logging';
import { isNonEmptyString, jsonError, readJsonBody, sanitizeText } from '@/lib/server/validation';

export const dynamic = 'force-dynamic';

/** Public catalog read. */
export async function GET() {
  try {
    const categories = await getCategoriesFromDb();
    return NextResponse.json({ success: true, count: categories.length, categories });
  } catch (e: any) {
    logger.error('categories_get_error', { error: e?.message });
    return jsonError('Failed to fetch categories', 500);
  }
}

/** Create a category — authenticated store admins only. */
export async function POST(req: NextRequest) {
  const admin = await authenticateAdmin(req);
  if (!admin) return jsonError('Authentication required', 401);

  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);
  if (!isNonEmptyString(body.name, 80)) {
    return jsonError('Category name is required (maximum 80 characters)', 400);
  }

  const name = sanitizeText(body.name, 80);
  const slug = slugifyCategoryName(name);
  if (!slug) return jsonError('Please use a category name containing letters or numbers', 400);

  if (body.description != null && typeof body.description !== 'string') {
    return jsonError('Category description must be text', 400);
  }
  if (typeof body.description === 'string' && body.description.trim().length > 500) {
    return jsonError('Category description must be 500 characters or fewer', 400);
  }
  const description = typeof body.description === 'string' && body.description.trim()
    ? sanitizeText(body.description, 500)
    : null;
  const client = getServerAdminClient();
  if (!client) return jsonError('Category management is not configured on the server', 503);

  try {
    const { data: existingBySlug, error: slugLookupError } = await (client.from('categories') as any)
      .select('id')
      .eq('slug', slug)
      .maybeSingle();
    if (slugLookupError) {
      logger.error('category_lookup_error', { admin: admin.userId, error: slugLookupError.message });
      return jsonError('Could not check whether this category already exists', 500);
    }
    if (existingBySlug) return jsonError('A category with this name already exists', 409);

    const namePattern = name.replace(/[\\%_]/g, '\\$&');
    const { data: existingByName, error: nameLookupError } = await (client.from('categories') as any)
      .select('id')
      .ilike('name', namePattern)
      .maybeSingle();
    if (nameLookupError) {
      logger.error('category_name_lookup_error', { admin: admin.userId, error: nameLookupError.message });
      return jsonError('Could not check whether this category already exists', 500);
    }
    if (existingByName) return jsonError('A category with this name already exists', 409);

    const now = new Date().toISOString();
    const { data: category, error } = await (client.from('categories') as any)
      .insert({ name, slug, description, created_at: now, updated_at: now })
      .select('id, name, slug, description, created_at')
      .single();

    if (error) {
      if (error.code === '23505') return jsonError('A category with this name already exists', 409);
      logger.error('category_create_error', { admin: admin.userId, error: error.message });
      return jsonError('Could not create category. Please try again.', 500);
    }

    logger.info('category_created', { admin: admin.userId, categoryId: category.id, slug });
    return NextResponse.json({ success: true, category }, { status: 201 });
  } catch (e: any) {
    logger.error('category_create_exception', { admin: admin.userId, error: e?.message });
    return jsonError('Could not create category. Please try again.', 500);
  }
}
