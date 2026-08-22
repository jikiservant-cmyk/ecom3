import { NextRequest, NextResponse } from 'next/server';
import { getReviewsFromDb, addReviewToDb } from '@/lib/supabaseDb';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const productId = searchParams.get('productId') || undefined;
    const reviews = await getReviewsFromDb(productId);
    return NextResponse.json({ success: true, count: reviews.length, reviews });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to fetch reviews' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const result = await addReviewToDb(body);
    return NextResponse.json(result, { status: result.success ? 201 : 400 });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to add review' },
      { status: 500 }
    );
  }
}
