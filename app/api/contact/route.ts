import { NextRequest, NextResponse } from 'next/server';
import { authenticateAdmin, getServerAdminClient } from '@/lib/server/supabaseServer';
import { logger } from '@/lib/server/logging';
import { readJsonBody, isNonEmptyString, isEmail, sanitizeText, jsonError } from '@/lib/server/validation';

export const dynamic = 'force-dynamic';

/** List contact messages — admin only (contains customer PII). */
export async function GET(req: NextRequest) {
  const admin = await authenticateAdmin(req);
  if (!admin) return jsonError('Authentication required', 401);

  try {
    const client = getServerAdminClient();
    if (!client) return jsonError('Server database access is not configured', 503);
    const limit = Math.min(Number(new URL(req.url).searchParams.get('limit') || 100), 500);
    const offset = Math.max(Number(new URL(req.url).searchParams.get('offset') || 0), 0);
    const { data: messages, error, count } = await (client.from('contact_messages') as any)
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) {
      logger.error('contact_list_error', { error: error.message });
      return jsonError('Failed to fetch messages', 500);
    }
    return NextResponse.json({ success: true, count, messages });
  } catch (e: any) {
    logger.error('contact_list_exception', { error: e?.message });
    return jsonError('Failed to fetch messages', 500);
  }
}

/** Submit a contact message — public, validated, rate-limited in middleware. */
export async function POST(req: NextRequest) {
  const body = await readJsonBody(req);
  if (!body) return jsonError('Invalid JSON body', 400);

  if (!isNonEmptyString(body.name, 200)) return jsonError('Please provide your name', 400);
  if (!isEmail(body.email)) return jsonError('Please provide a valid email address', 400);
  if (!isNonEmptyString(body.message, 5000)) return jsonError('Please provide a message', 400);
  const topic = isNonEmptyString(body.topic, 200) ? sanitizeText(body.topic, 200) : 'General Inquiry';

  try {
    const client = getServerAdminClient();
    if (!client) return jsonError('Contact form is not configured', 503);
    const { error } = await (client.from('contact_messages') as any).insert({
      name: sanitizeText(body.name, 200),
      email: body.email.trim(),
      topic,
      message: sanitizeText(body.message, 5000),
      status: 'unread',
      created_at: new Date().toISOString(),
    });
    if (error) {
      logger.error('contact_insert_error', { error: error.message });
      return jsonError('Could not send your message right now. Please try again later.', 500);
    }
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (e: any) {
    logger.error('contact_insert_exception', { error: e?.message });
    return jsonError('Could not send your message right now. Please try again later.', 500);
  }
}
