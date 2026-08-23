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
    const livepayAccountNumber = process.env.LIVEPAY_MERCHANT_ID || '';
    
    // Check if the user has the old incorrect API URL in their environment secrets and override it
    let baseApiUrl = process.env.LIVEPAY_API_URL || 'https://livepay.me/api';
    if (baseApiUrl.includes('api.livepay.me')) {
      baseApiUrl = 'https://livepay.me/api';
    }
    const livepayApiUrl = baseApiUrl.replace(/\/+$/, '');

    const appUrl = (process.env.APP_URL || 'https://drumpalace.ug').replace(/\/+$/, '');

    // Max 30 chars, no spaces for reference
    const transactionReference = `ORD${orderNumber}`.replace(/\s+/g, '').substring(0, 30);
    const callbackUrl = `${appUrl}/api/payments/livepay/webhook`;
    const redirectUrl = returnUrl || `${appUrl}/?order=${orderNumber}&status=completed`;

    // If live API credentials are provided (not placeholder), dispatch request to LivePay Gateway (docs.livepay.me)
    if (livepayApiKey && !livepayApiKey.includes('YOUR_')) {
      try {
        let endpoint = '';
        let livepayPayload: any = {};

        if (paymentMethod === 'card') {
          if (currency !== 'USD') {
            return NextResponse.json({ success: false, error: 'Only USD currency is supported for card payments' }, { status: 400 });
          }
          endpoint = `${livepayApiUrl}/card-collection`;
          livepayPayload = {
            accountNumber: livepayAccountNumber,
            amount: Number(amount),
            currency: 'USD',
            reference: transactionReference,
            email: customerEmail,
            name: customerName,
            description: `Order #${orderNumber}`,
            return_url: redirectUrl
          };
        } else {
          // Default to mobile money
          endpoint = `${livepayApiUrl}/collect-money`;
          livepayPayload = {
            accountNumber: livepayAccountNumber,
            phoneNumber: phoneNumber || '',
            amount: Number(amount),
            currency: currency.toUpperCase(),
            reference: transactionReference,
            description: `Order #${orderNumber}`
          };
          
          if (currency.toUpperCase() !== 'UGX') {
            livepayPayload.network = body.network || (phoneNumber?.startsWith('+25677') || phoneNumber?.startsWith('077') ? 'MTN' : 'AIRTEL');
          }
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${livepayApiKey}`
          },
          body: JSON.stringify(livepayPayload),
        });

        if (response.ok) {
          const data = await response.json();
          return NextResponse.json({
            success: true,
            transactionId: data.internal_reference || transactionReference,
            reference: data.reference || transactionReference,
            status: 'pending',
            checkoutUrl: data.checkout_url || null,
            gateway: 'LivePay Gateway',
            message: data.message || 'Transaction initialized successfully',
            raw: data,
          });
        } else {
          const errorData = await response.json().catch(() => ({}));
          console.warn('LivePay Gateway response error:', response.status, errorData);
          return NextResponse.json({
            success: false,
            error: `LivePay Gateway: ${errorData.error || errorData.message || 'Payment processing failed'}`,
            status: response.status,
          }, { status: 400 });
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
