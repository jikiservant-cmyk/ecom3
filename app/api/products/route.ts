import { NextRequest, NextResponse } from 'next/server';
import { getProductsFromDb, getCategoriesFromDb, saveProductToDb, seedInitialDataToSupabase } from '@/lib/supabaseDb';

export async function GET(req: NextRequest) {
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
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to fetch products' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    
    if (body.action === 'seed') {
      const result = await seedInitialDataToSupabase();
      if (result.success === false || result.seededCount === 0 || (result.message && result.message.includes('fallback'))) {
         return NextResponse.json({ ...result, debug: true });
      }
      return NextResponse.json(result);
    }

    if (body.product) {
      const result = await saveProductToDb(body.product);
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: 'Invalid payload. Provide product object or action: "seed"' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to process product request' },
      { status: 500 }
    );
  }
}
