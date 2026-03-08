import { NextResponse } from 'next/server';
import { createAdminClient, getPricingMap } from '@/lib/supabase/admin';

const MAYAR_API_KEY = process.env.MAYAR_API_KEY || '';
const MAYAR_BASE_URL =
  process.env.MAYAR_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://api.mayar.id/hl/v1' : 'https://api.mayar.club/hl/v1');

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { amount, userId, email, name, mobile, redirectUrl } = body;

    if (!amount || !userId) {
      return NextResponse.json({ error: 'Amount and userId are required' }, { status: 400 });
    }

    const pricing = await getPricingMap();
    const creditPerIdr = pricing.get('credit_per_idr') ?? 0.1;
    const creditsAdded = Math.max(1, Math.floor(amount * creditPerIdr));

    const admin = createAdminClient();
    const { data: existingPending } = await admin
      .from('transactions')
      .select('invoice_id,checkout_url,status,created_at')
      .eq('user_id', userId)
      .eq('status', 'unpaid')
      .eq('amount', amount)
      .eq('payment_method', 'mayar')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingPending?.invoice_id && existingPending?.checkout_url) {
      return NextResponse.json({
        success: true,
        invoiceId: existingPending.invoice_id,
        checkoutUrl: existingPending.checkout_url,
        reused: true,
      });
    }

    // Call Mayar Headless API to create invoice
    const mayarPayload = {
      name: name || 'Web2APK User',
      email: email || 'user@example.com',
      mobile: mobile || '08123456789',
      redirectUrl: redirectUrl || process.env.PAYMENT_REDIRECT_URL || 'https://app.domain.com/dashboard/topup',
      description: `Topup Saldo Web2APK - ${creditsAdded} Credits`,
      // Set expired at +24 hours
      expiredAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      items: [
        {
          quantity: 1,
          rate: amount,
          description: `Topup ${creditsAdded} Web2APK Credits`
        }
      ],
      extraData: {
        noCustomer: email || 'user@example.com',
        idProd: 'web2apk-credit',
        userId: userId,
        credits: creditsAdded
      }
    };

    const mayarResponse = await fetch(`${MAYAR_BASE_URL}/invoice/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MAYAR_API_KEY}`
      },
      body: JSON.stringify(mayarPayload)
    });

    const mayarData = await mayarResponse.json();

    if (!mayarResponse.ok || !mayarData.data) {
      console.error('Mayar API Error:', mayarData);
      return NextResponse.json({ error: 'Failed to create Mayar Invoice' }, { status: 500 });
    }

    const { error: insertError } = await admin.from('transactions').insert({
      user_id: userId,
      invoice_id: mayarData.data.id,
      amount,
      credits_added: creditsAdded,
      status: 'unpaid',
      checkout_url: mayarData.data.link,
      payment_method: 'mayar',
    });

    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ 
      success: true, 
      invoiceId: mayarData.data.id,
      checkoutUrl: mayarData.data.link
    });

  } catch (error) {
    console.error('Payment create error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
