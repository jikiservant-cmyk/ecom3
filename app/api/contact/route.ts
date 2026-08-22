import { NextRequest, NextResponse } from 'next/server';
import { getContactMessagesFromDb, saveContactMessageToDb } from '@/lib/supabaseDb';

export async function GET(req: NextRequest) {
  try {
    const messages = await getContactMessagesFromDb();
    return NextResponse.json({ success: true, count: messages.length, messages });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to fetch messages' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const result = await saveContactMessageToDb(body);
    return NextResponse.json(result, { status: result.success ? 201 : 400 });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to send message' },
      { status: 500 }
    );
  }
}
