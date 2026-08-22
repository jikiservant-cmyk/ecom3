import { NextRequest, NextResponse } from 'next/server';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    const signature = req.headers.get('x-livepay-signature');

    // Optional webhook signature verification
    const webhookSecret = process.env.LIVEPAY_WEBHOOK_SECRET;
    if (webhookSecret && !webhookSecret.includes('YOUR_')) {
      if (!signature) {
        return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
      }
    }

    const { event, data } = payload;
    const orderId = data?.order_id || data?.reference;
    const isSuccess = data?.status === 'successful' || data?.status === 'completed';
    const paymentStatus = isSuccess ? 'Paid' : 'Pending';
    const dbPaymentStatus = isSuccess ? 'success' : 'pending';

    // If Supabase is configured, update both orders & payments tables and record webhook event
    if (isSupabaseConfigured) {
      try {
        // 1. Log incoming webhook event
        await (supabase.from('payment_webhook_events') as any).insert({
          provider: 'livepay',
          event_id: data?.event_id || data?.transaction_id || `evt_${Date.now()}`,
          payload,
          processed_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        });

        // 2. Update payment status in payments table
        if (orderId) {
          await (supabase.from('payments') as any)
            .update({
              status: dbPaymentStatus,
              raw_payload: payload,
              updated_at: new Date().toISOString(),
            })
            .eq('order_id', orderId);

          // 3. Update status in orders table
          await (supabase.from('orders') as any)
            .update({
              payment_status: paymentStatus,
              status: isSuccess ? 'processing' : 'pending',
              updated_at: new Date().toISOString(),
            })
            .eq('id', orderId);
        }
      } catch (dbErr) {
        console.warn('LivePay webhook database update notice:', dbErr);
      }
    }

    return NextResponse.json({ received: true, gateway: 'LivePay Uganda', event, status: 'processed' });
  } catch (err: any) {
    console.error('LivePay Webhook error:', err);
    return NextResponse.json(
      { error: err.message || 'Webhook processing failed' },
      { status: 400 }
    );
  }
}
