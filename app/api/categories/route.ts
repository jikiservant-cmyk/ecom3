import { NextRequest, NextResponse } from 'next/server';
import { getCategoriesFromDb } from '@/lib/supabaseDb';

export async function GET(req: NextRequest) {
  try {
    const categories = await getCategoriesFromDb();
    return NextResponse.json({ success: true, count: categories.length, categories });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to fetch categories' },
      { status: 500 }
    );
  }
}
