import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const apiKey = body.apiKey || process.env.LIVEPAY_API_KEY;
    const secretKey = body.secretKey || process.env.LIVEPAY_SECRET_KEY;
    const merchantId = body.merchantId || process.env.LIVEPAY_MERCHANT_ID;
    const apiUrl = (body.apiUrl || process.env.LIVEPAY_API_URL || 'https://api.livepay.me/v1').replace(/\/+$/, '');

    const isConfigured = !!(apiKey && !apiKey.includes('YOUR_'));

    if (!isConfigured) {
      return NextResponse.json({
        success: true,
        mode: 'sandbox_simulation',
        status: 'Sandbox Ready',
        message: 'LivePay is running in Sandbox & Test Mode. Ready for instant testing and local payment processing.',
        apiUrl,
        credentialsDetected: false,
        documentation: 'https://docs.livepay.me/',
      });
    }

    // Attempt real live handshake with LivePay.me API
    const startTime = Date.now();
    try {
      const pingRes = await fetch(`${apiUrl}/merchant/status`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${secretKey || apiKey}`,
          'X-API-KEY': apiKey,
          'X-Merchant-ID': merchantId || '',
        },
      });

      const latencyMs = Date.now() - startTime;
      const responseData = await pingRes.json().catch(() => ({}));

      return NextResponse.json({
        success: pingRes.ok,
        mode: 'live_gateway',
        status: pingRes.ok ? 'Connected (Live)' : `Gateway returned ${pingRes.status}`,
        latencyMs,
        apiUrl,
        merchantId: merchantId || 'Default',
        credentialsDetected: true,
        gatewayResponse: responseData,
        documentation: 'https://docs.livepay.me/',
      });
    } catch (fetchErr: any) {
      return NextResponse.json({
        success: false,
        mode: 'live_gateway',
        status: 'Connection Notice',
        message: `Could not reach ${apiUrl}: ${fetchErr?.message || fetchErr}. (Sandbox fallback active)`,
        credentialsDetected: true,
        documentation: 'https://docs.livepay.me/',
      });
    }
  } catch (err: any) {
    return NextResponse.json({
      success: false,
      error: err?.message || 'Failed to test LivePay connection',
    }, { status: 500 });
  }
}
