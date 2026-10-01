import { NextResponse } from 'next/server';
import { getCategoriesFromDb } from '@/lib/supabaseDb';
import { logger } from '@/lib/server/logging';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const categories = await getCategoriesFromDb();
    return NextResponse.json({ success: true, count: categories.length, categories });
  } catch (e: any) {
    logger.error('categories_get_error', { error: e?.message });
    return NextResponse.json({ success: false, error: 'Failed to fetch categories' }, { status: 500 });
  }
}
