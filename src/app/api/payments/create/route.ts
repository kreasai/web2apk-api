import { NextResponse } from 'next/server';
import { createAdminClient, getPricingMap } from '@/lib/supabase/admin';
import { corsHeaders } from '@/lib/cors';
import { randomUUID } from 'crypto';

const MAYAR_API_KEY = process.env.MAYAR_API_KEY || '';
const MAYAR_BASE_URL =
  process.env.MAYAR_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://api.mayar.id/hl/v1' : 'https://api.mayar.club/hl/v1');
const MAYAR_CREDIT_BASE_URL =
  process.env.MAYAR_CREDIT_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://api.mayar.id/credit/v1' : 'https://api.mayar.club/credit/v1');
const MAYAR_CREDIT_PRODUCT_ID = process.env.MAYAR_CREDIT_PRODUCT_ID || '';
const MAYAR_INTEGRATION_MODE =
  process.env.MAYAR_INTEGRATION_MODE || (MAYAR_CREDIT_PRODUCT_ID ? 'usage_membership' : 'headless_invoice');
const MAYAR_CREDIT_MEMBERSHIP_TIER_ID = process.env.MAYAR_CREDIT_MEMBERSHIP_TIER_ID || '';
const MAYAR_CREDIT_MEMBERSHIP_PERIOD = Number(process.env.MAYAR_CREDIT_MEMBERSHIP_PERIOD || '1');

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { amount, userId, email, name, mobile, redirectUrl } = body;
    const normalizedAmount = Number(amount);

    if (!normalizedAmount || Number.isNaN(normalizedAmount) || normalizedAmount <= 0 || !userId) {
      return NextResponse.json({ error: 'Amount and userId are required' }, { status: 400 });
    }

    if (!MAYAR_API_KEY) {
      return NextResponse.json(
        {
          error: 'MAYAR_API_KEY is not configured',
          integrationMode: MAYAR_INTEGRATION_MODE,
        },
        { status: 500 },
      );
    }

    const pricing = await getPricingMap();
    const creditPerIdr = pricing.get('credit_per_idr') ?? 0.1;
    const minTopupIdr = Math.floor(
      pricing.get('topup_min_idr') ??
      pricing.get('mayar_min_payment_idr') ??
      10_000,
    );
    const maxTopupIdr = Math.floor(
      pricing.get('topup_max_idr') ??
      pricing.get('mayar_max_payment_idr') ??
      100_000,
    );

    if (normalizedAmount < minTopupIdr) {
      return NextResponse.json(
        {
          error: `Minimal topup Rp ${minTopupIdr.toLocaleString('id-ID')}`,
          minTopupIdr,
        },
        { status: 400 },
      );
    }

    if (normalizedAmount > maxTopupIdr) {
      return NextResponse.json(
        {
          error: `Maksimal topup Rp ${maxTopupIdr.toLocaleString('id-ID')}`,
          maxTopupIdr,
        },
        { status: 400 },
      );
    }

    const creditsAdded = Math.max(1, Math.floor(normalizedAmount * creditPerIdr));

    const admin = createAdminClient();
    const paymentMethod = MAYAR_INTEGRATION_MODE === 'usage_membership' ? 'mayar_credit' : 'mayar';

    if (paymentMethod === 'mayar_credit') {
      await admin
        .from('transactions')
        .update({ status: 'expired', updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('status', 'unpaid')
        .eq('amount', normalizedAmount)
        .eq('payment_method', paymentMethod);
    }

    const { data: existingPending } = await admin
      .from('transactions')
      .select('invoice_id,checkout_url,status,created_at')
      .eq('user_id', userId)
      .eq('status', 'unpaid')
      .eq('amount', normalizedAmount)
      .eq('payment_method', paymentMethod)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (
      paymentMethod !== 'mayar_credit' &&
      existingPending?.invoice_id &&
      existingPending?.checkout_url
    ) {
      return NextResponse.json({
        success: true,
        invoiceId: existingPending.invoice_id,
        checkoutUrl: existingPending.checkout_url,
        reused: true,
      });
    }

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
          rate: normalizedAmount,
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

    const baseUrl = MAYAR_BASE_URL.replace(/\/$/, '');
    let mayarData: Record<string, unknown> | null = null;
    let checkoutUrl = '';
    let invoiceId = '';
    let upstreamStatus = 500;
    let lastErrorMessage = 'Unknown Mayar error';
    const tryCreate = async (endpoint: '/invoice/create' | '/payment/create', payload: unknown) => {
      const mayarResponse = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${MAYAR_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      upstreamStatus = mayarResponse.status;
      const rawText = await mayarResponse.text();

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : null;
      } catch {
        parsed = { message: rawText || 'Invalid JSON from Mayar' };
      }

      mayarData = parsed;
      const dataObj = parsed && typeof parsed.data === 'object' && parsed.data !== null
        ? (parsed.data as Record<string, unknown>)
        : null;
      const candidateLink = typeof dataObj?.link === 'string' ? dataObj.link : '';
      const candidateId = typeof dataObj?.id === 'string' ? dataObj.id : '';
      const parsedMessage =
        (typeof parsed?.messages === 'string' && parsed.messages) ||
        (typeof parsed?.message === 'string' && parsed.message) ||
        (typeof parsed?.error === 'string' && parsed.error) ||
        (typeof rawText === 'string' && rawText) ||
        `Request failed at ${endpoint}`;

      return {
        ok: mayarResponse.ok,
        status: mayarResponse.status,
        link: candidateLink,
        id: candidateId,
        message: parsedMessage,
      };
    };

    if (MAYAR_INTEGRATION_MODE === 'usage_membership') {
      if (!MAYAR_CREDIT_PRODUCT_ID) {
        return NextResponse.json(
          {
            error: 'MAYAR_CREDIT_PRODUCT_ID is not configured',
            integrationMode: MAYAR_INTEGRATION_MODE,
          },
          { status: 500 },
        );
      }

      if (MAYAR_CREDIT_MEMBERSHIP_TIER_ID) {
        const registrationPayload = {
          productId: MAYAR_CREDIT_PRODUCT_ID,
          membershipTierId: MAYAR_CREDIT_MEMBERSHIP_TIER_ID,
          membershipMonthlyPeriod:
            MAYAR_CREDIT_MEMBERSHIP_PERIOD === 1 ||
            MAYAR_CREDIT_MEMBERSHIP_PERIOD === 3 ||
            MAYAR_CREDIT_MEMBERSHIP_PERIOD === 6 ||
            MAYAR_CREDIT_MEMBERSHIP_PERIOD === 12
              ? MAYAR_CREDIT_MEMBERSHIP_PERIOD
              : 1,
          customerInfo: {
            name: name || 'Web2APK User',
            email: email || 'user@example.com',
            mobile: mobile || '08123456789',
          },
        };

        const registerResponse = await fetch(
          `${MAYAR_CREDIT_BASE_URL.replace(/\/$/, '')}/credit/membership/customer/regist`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${MAYAR_API_KEY}`,
            },
            body: JSON.stringify(registrationPayload),
          },
        );

        const registerRaw = await registerResponse.text();
        let registerParsed: Record<string, unknown> | null = null;
        try {
          registerParsed = registerRaw ? (JSON.parse(registerRaw) as Record<string, unknown>) : null;
        } catch {
          registerParsed = null;
        }

        const registerMessage =
          (typeof registerParsed?.messages === 'string' && registerParsed.messages) ||
          (typeof registerParsed?.message === 'string' && registerParsed.message) ||
          (typeof registerParsed?.error === 'string' && registerParsed.error) ||
          registerRaw ||
          '';

        if (!registerResponse.ok) {
          const normalizedRegisterMessage = registerMessage.toLowerCase();
          const isAlreadyRegistered =
            normalizedRegisterMessage.includes('already') &&
            (normalizedRegisterMessage.includes('register') || normalizedRegisterMessage.includes('member'));

          if (!isAlreadyRegistered) {
            return NextResponse.json(
              {
                error: 'Failed to register membership customer in Mayar',
                details: registerMessage,
                upstreamStatus: registerResponse.status,
                baseUrl: MAYAR_CREDIT_BASE_URL,
              },
              { status: 500 },
            );
          }
        }
      }

      const creditPayload = {
        productId: MAYAR_CREDIT_PRODUCT_ID,
        customerInfo: {
          name: name || 'Web2APK User',
          email: email || 'user@example.com',
          mobile: mobile || '08123456789',
        },
        creditAmount: creditsAdded,
      };

      const creditResponse = await fetch(`${MAYAR_CREDIT_BASE_URL.replace(/\/$/, '')}/credit/generate/immutable/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${MAYAR_API_KEY}`,
        },
        body: JSON.stringify(creditPayload),
      });

      upstreamStatus = creditResponse.status;
      const rawText = await creditResponse.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : null;
      } catch {
        parsed = { message: rawText || 'Invalid JSON from Mayar Credit API' };
      }
      mayarData = parsed;

      const dataObj = parsed && typeof parsed.data === 'object' && parsed.data !== null
        ? (parsed.data as Record<string, unknown>)
        : null;

      const directPaymentLink = typeof dataObj?.paymentLinkUrl === 'string' ? dataObj.paymentLinkUrl : '';
      const immutableCheckoutLink = typeof dataObj?.creditUsageImmutableCheckoutUrl === 'string'
        ? dataObj.creditUsageImmutableCheckoutUrl
        : '';
      const creditPaymentLinkId = typeof dataObj?.paymentLinkId === 'string' ? dataObj.paymentLinkId : '';
      const selectedCheckout = immutableCheckoutLink || directPaymentLink;

      if (creditResponse.ok && selectedCheckout) {
        checkoutUrl = selectedCheckout;
        invoiceId = creditPaymentLinkId || `mayar-credit:${randomUUID()}`;
      } else {
        lastErrorMessage =
          (typeof parsed?.messages === 'string' && parsed.messages) ||
          (typeof parsed?.message === 'string' && parsed.message) ||
          (typeof parsed?.error === 'string' && parsed.error) ||
          rawText ||
          'Failed generating immutable checkout link';
      }
    } else {
      const invoiceAttempt = await tryCreate('/invoice/create', mayarPayload);

      if (invoiceAttempt.ok && invoiceAttempt.link && invoiceAttempt.id) {
        checkoutUrl = invoiceAttempt.link;
        invoiceId = invoiceAttempt.id;
      } else if (invoiceAttempt.status === 404 || invoiceAttempt.status === 405) {
        console.warn('Mayar invoice endpoint unavailable, trying payment endpoint fallback', {
          status: invoiceAttempt.status,
        });
        const paymentPayload = {
          name: name || 'Web2APK User',
          email: email || 'user@example.com',
          mobile: mobile || '08123456789',
          redirectUrl: redirectUrl || process.env.PAYMENT_REDIRECT_URL || 'https://app.domain.com/dashboard/topup',
          description: `Topup Saldo Web2APK - ${creditsAdded} Credits`,
          amount: normalizedAmount,
        };
        const paymentAttempt = await tryCreate('/payment/create', paymentPayload);

        if (paymentAttempt.ok && paymentAttempt.link && paymentAttempt.id) {
          checkoutUrl = paymentAttempt.link;
          invoiceId = paymentAttempt.id;
        } else {
          lastErrorMessage = paymentAttempt.message;
        }
      } else {
        lastErrorMessage = invoiceAttempt.message;
      }
    }

    if (!checkoutUrl || !invoiceId) {
      console.error('Mayar API Error:', {
        baseUrl,
        upstreamStatus,
        mayarData,
      });
      return NextResponse.json(
        {
          error: 'Failed to create Mayar Invoice',
          details: lastErrorMessage,
          upstreamStatus,
          baseUrl: MAYAR_INTEGRATION_MODE === 'usage_membership' ? MAYAR_CREDIT_BASE_URL : baseUrl,
          integrationMode: MAYAR_INTEGRATION_MODE,
        },
        { status: 500 },
      );
    }

    const { error: insertError } = await admin.from('transactions').insert({
      user_id: userId,
      invoice_id: invoiceId,
      amount: normalizedAmount,
      credits_added: creditsAdded,
      status: 'unpaid',
      checkout_url: checkoutUrl,
      payment_method: paymentMethod,
    });

    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ 
      success: true, 
      invoiceId,
      checkoutUrl
    });

  } catch (error) {
    console.error('Payment create error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
