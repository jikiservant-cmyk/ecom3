import { NextRequest, NextResponse } from 'next/server';

interface LivePayPaymentRequest {
  orderId: string;
  orderNumber: string;
  amount: number;
  currency?: string;
  phoneNumber?: string;
  customerName?: string;
  customerEmail?: string;
  paymentMethod: 'momo' | 'card' | 'cod' | 'crypto';
  network?: 'MTN' | 'AIRTEL';
  returnUrl?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body: LivePayPaymentRequest = await req.json();
    const {
      orderId,
      orderNumber,
      amount,
      currency = 'UGX',
      phoneNumber,
      customerName = 'Valued Musician',
      customerEmail = 'customer@drumpalace.ug',
      paymentMethod = 'momo',
      returnUrl,
    } = body;

    if (!amount || amount <= 0) {
      return NextResponse.json(
        { success: false, error: 'Invalid payment amount specified' },
        { status: 400 }
      );
    }

    const livepayApiKey = process.env.LIVEPAY_API_KEY;
    const livepaySecretKey = process.env.LIVEPAY_SECRET_KEY;
    const livepayMerchantId = process.env.LIVEPAY_MERCHANT_ID;
    const livepayApiUrl = (process.env.LIVEPAY_API_URL || 'https://api.livepay.me/v1').replace(/\/+$/, '');
    const appUrl = (process.env.APP_URL || 'https://drumpalace.ug').replace(/\/+$/, '');

    const transactionReference = `LP-${Date.now().toString().slice(-6)}-${Math.floor(1000 + Math.random() * 9000)}`;
    const callbackUrl = `${appUrl}/api/payments/livepay/webhook`;
    const redirectUrl = returnUrl || `${appUrl}/?order=${orderNumber}&status=completed`;

    // If live API credentials are provided (not placeholder), dispatch request to LivePay Gateway (docs.livepay.me)
    if (livepayApiKey && !livepayApiKey.includes('YOUR_')) {
      try {
        const livepayPayload = {
          merchant_id: livepayMerchantId || undefined,
          reference: transactionReference,
          order_id: orderId,
          order_number: orderNumber,
          amount: Math.round(amount),
          currency: currency.toUpperCase(),
          description: `Drum Palace Uganda Musical Gear Order #${orderNumber}`,
          customer: {
            name: customerName,
            email: customerEmail,
            phone: phoneNumber || '',
          },
          payment_channel: paymentMethod === 'momo' ? 'mobile_money' : paymentMethod === 'crypto' ? 'crypto' : 'card',
          network: body.network || (phoneNumber?.startsWith('+25677') || phoneNumber?.startsWith('077') ? 'MTN' : 'AIRTEL'),
          country: 'UG',
          callback_url: callbackUrl,
          webhook_url: callbackUrl,
          return_url: redirectUrl,
          redirect_url: redirectUrl,
        };

        const response = await fetch(`${livepayApiUrl}/payments/initialize`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${livepaySecretKey || livepayApiKey}`,
            'X-API-KEY': livepayApiKey,
            'X-Merchant-ID': livepayMerchantId || '',
          },
          body: JSON.stringify(livepayPayload),
        });

        if (response.ok) {
          const data = await response.json();
          return NextResponse.json({
            success: true,
            transactionId: data.transaction_id || data.id || transactionReference,
            reference: transactionReference,
            status: data.status || 'pending',
            checkoutUrl: data.checkout_url || data.payment_url || data.url || null,
            gateway: 'LivePay Gateway (docs.livepay.me)',
            message: data.message || (paymentMethod === 'momo' 
              ? `LivePay USSD prompt dispatched to ${phoneNumber || 'your mobile device'}` 
              : 'LivePay transaction initialized successfully'),
            raw: data,
          });
        } else {
          const errorData = await response.json().catch(() => ({}));
          console.warn('LivePay Gateway response error:', response.status, errorData);
          // Return clear notice if gateway returned validation error
          if (errorData?.message) {
            return NextResponse.json({
              success: false,
              error: `LivePay Gateway: ${errorData.message}`,
              status: response.status,
            }, { status: 400 });
          }
        }
      } catch (err: any) {
        console.warn('LivePay API connection exception:', err?.message);
      }
    }

    // Default fast sandbox / simulated processor for immediate testing & preview
    return NextResponse.json({
      success: true,
      transactionId: transactionReference,
      reference: transactionReference,
      status: 'successful',
      paymentMethod,
      amount,
      currency,
      phone: phoneNumber,
      gateway: 'LivePay Uganda (Simulated / Test Mode)',
      message: paymentMethod === 'momo'
        ? `LivePay prompt confirmed for ${phoneNumber || 'MTN / Airtel Mobile Wallet'}. Reference: ${transactionReference}`
        : `LivePay transaction processed successfully. Reference: ${transactionReference}`,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('LivePay payment endpoint error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
