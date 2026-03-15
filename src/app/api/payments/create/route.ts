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

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function withServiceVersionCandidates(base: string, service: 'hl' | 'credit') {
  const normalized = normalizeBaseUrl(base);
  const targetSegment = service === 'hl' ? '/hl/v1' : '/credit/v1';
  const alternateSegment = service === 'hl' ? '/credit/v1' : '/hl/v1';

  const candidates = new Set<string>([normalized]);

  if (!normalized.includes(targetSegment)) {
    candidates.add(`${normalized}${targetSegment}`);
  }

  if (normalized.includes(alternateSegment)) {
    candidates.add(normalized.replace(alternateSegment, targetSegment));
  }

  return Array.from(candidates);
}

async function postMayarJson(
  url: string,
  apiKey: string,
  payload: unknown,
): Promise<{
  ok: boolean;
  status: number;
  rawText: string;
  parsed: Record<string, unknown> | null;
}> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : null;
  } catch {
    parsed = { message: rawText || 'Invalid JSON response' };
  }

  return {
    ok: response.ok,
    status: response.status,
    rawText,
    parsed,
  };
}

function stripExtraData(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  const record = payload as Record<string, unknown>;
  const { extraData: _extraData, ...withoutExtraData } = record;
  return withoutExtraData;
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { amount, credits, userId, email, name, mobile, redirectUrl } = body;

    const hasAmount = amount !== undefined && amount !== null && amount !== '';
    const hasCredits = credits !== undefined && credits !== null && credits !== '';

    if (!userId || (!hasAmount && !hasCredits)) {
      return NextResponse.json({ error: 'amount or credits and userId are required' }, { status: 400 });
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

    if (!creditPerIdr || Number.isNaN(creditPerIdr) || creditPerIdr <= 0) {
      return NextResponse.json(
        {
          error: 'Invalid pricing configuration: credit_per_idr must be greater than 0',
        },
        { status: 500 },
      );
    }

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

    let normalizedAmount = 0;
    let creditsAdded = 0;

    if (hasCredits) {
      const normalizedCredits = Math.floor(Number(credits));
      if (!normalizedCredits || Number.isNaN(normalizedCredits) || normalizedCredits <= 0) {
        return NextResponse.json({ error: 'credits must be a positive integer' }, { status: 400 });
      }

      normalizedAmount = Math.ceil(normalizedCredits / creditPerIdr);
      if (!normalizedAmount || Number.isNaN(normalizedAmount) || normalizedAmount <= 0) {
        return NextResponse.json({ error: 'Failed to derive payment amount from credits' }, { status: 400 });
      }

      let computedCredits = Math.max(1, Math.floor(normalizedAmount * creditPerIdr));
      let adjustmentCount = 0;
      while (computedCredits < normalizedCredits && adjustmentCount < 5) {
        normalizedAmount += 1;
        computedCredits = Math.max(1, Math.floor(normalizedAmount * creditPerIdr));
        adjustmentCount += 1;
      }

      creditsAdded = computedCredits;
    } else {
      const parsedAmount = Number(amount);
      normalizedAmount = Math.floor(parsedAmount);
      if (!normalizedAmount || Number.isNaN(normalizedAmount) || normalizedAmount <= 0) {
        return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 });
      }

      creditsAdded = Math.max(1, Math.floor(normalizedAmount * creditPerIdr));
    }

    if (normalizedAmount < minTopupIdr) {
      const minCredits = Math.max(1, Math.ceil(minTopupIdr * creditPerIdr));
      return NextResponse.json(
        {
          error: hasCredits
            ? `Minimal pembelian ${minCredits.toLocaleString('id-ID')} kredit`
            : `Minimal topup Rp ${minTopupIdr.toLocaleString('id-ID')}`,
          minTopupIdr,
          minCredits,
        },
        { status: 400 },
      );
    }

    if (normalizedAmount > maxTopupIdr) {
      const maxCredits = Math.max(1, Math.floor(maxTopupIdr * creditPerIdr));
      return NextResponse.json(
        {
          error: hasCredits
            ? `Maksimal pembelian ${maxCredits.toLocaleString('id-ID')} kredit`
            : `Maksimal topup Rp ${maxTopupIdr.toLocaleString('id-ID')}`,
          maxTopupIdr,
          maxCredits,
        },
        { status: 400 },
      );
    }

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

    const baseUrl = normalizeBaseUrl(MAYAR_BASE_URL);
    let mayarData: Record<string, unknown> | null = null;
    let checkoutUrl = '';
    let invoiceId = '';
    let upstreamStatus = 500;
    let lastErrorMessage = 'Unknown Mayar error';
    let attemptedUrl = '';
    const tryCreate = async (endpoint: '/invoice/create' | '/payment/create', payload: unknown) => {
      const baseCandidates = withServiceVersionCandidates(baseUrl, 'hl');
      let selectedResult: {
        ok: boolean;
        status: number;
        rawText: string;
        parsed: Record<string, unknown> | null;
      } | null = null;

      for (const candidateBase of baseCandidates) {
        const url = `${candidateBase}${endpoint}`;
        attemptedUrl = url;
        const result = await postMayarJson(url, MAYAR_API_KEY, payload);

        selectedResult = result;
        if (result.status !== 404) {
          break;
        }
      }

      const finalResult = selectedResult ?? {
        ok: false,
        status: 500,
        rawText: '',
        parsed: { message: `No response from Mayar for ${endpoint}` },
      };

      upstreamStatus = finalResult.status;
      mayarData = finalResult.parsed;
      const dataObj = finalResult.parsed && typeof finalResult.parsed.data === 'object' && finalResult.parsed.data !== null
        ? (finalResult.parsed.data as Record<string, unknown>)
        : null;
      const candidateLink = typeof dataObj?.link === 'string' ? dataObj.link : '';
      const candidateId = typeof dataObj?.id === 'string' ? dataObj.id : '';
      const parsedMessage =
        (typeof finalResult.parsed?.messages === 'string' && finalResult.parsed.messages) ||
        (typeof finalResult.parsed?.message === 'string' && finalResult.parsed.message) ||
        (typeof finalResult.parsed?.error === 'string' && finalResult.parsed.error) ||
        (typeof finalResult.rawText === 'string' && finalResult.rawText) ||
        `Request failed at ${endpoint}`;

      return {
        ok: finalResult.ok,
        status: finalResult.status,
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

        const creditBases = withServiceVersionCandidates(MAYAR_CREDIT_BASE_URL, 'credit');
        let registerResult: {
          ok: boolean;
          status: number;
          rawText: string;
          parsed: Record<string, unknown> | null;
        } | null = null;

        for (const creditBase of creditBases) {
          const url = `${creditBase}/credit/membership/customer/regist`;
          attemptedUrl = url;
          const result = await postMayarJson(url, MAYAR_API_KEY, registrationPayload);
          registerResult = result;
          if (result.status !== 404) {
            break;
          }
        }

        const finalRegisterResult = registerResult ?? {
          ok: false,
          status: 500,
          rawText: '',
          parsed: { message: 'No response from Mayar membership registration endpoint' },
        };

        upstreamStatus = finalRegisterResult.status;
        const registerParsed = finalRegisterResult.parsed;
        const registerRaw = finalRegisterResult.rawText;

        const registerMessage =
          (typeof registerParsed?.messages === 'string' && registerParsed.messages) ||
          (typeof registerParsed?.message === 'string' && registerParsed.message) ||
          (typeof registerParsed?.error === 'string' && registerParsed.error) ||
          registerRaw ||
          '';

        if (!finalRegisterResult.ok) {
          const normalizedRegisterMessage = registerMessage.toLowerCase();
          const isAlreadyRegistered =
            normalizedRegisterMessage.includes('already') &&
            (normalizedRegisterMessage.includes('register') || normalizedRegisterMessage.includes('member'));

          if (!isAlreadyRegistered) {
            return NextResponse.json(
              {
                error: 'Failed to register membership customer in Mayar',
                details: registerMessage,
                upstreamStatus: finalRegisterResult.status,
                baseUrl: MAYAR_CREDIT_BASE_URL,
                attemptedUrl,
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

      const creditBases = withServiceVersionCandidates(MAYAR_CREDIT_BASE_URL, 'credit');
      let creditResult: {
        ok: boolean;
        status: number;
        rawText: string;
        parsed: Record<string, unknown> | null;
      } | null = null;

      for (const creditBase of creditBases) {
        const url = `${creditBase}/credit/generate/immutable/checkout`;
        attemptedUrl = url;
        const result = await postMayarJson(url, MAYAR_API_KEY, creditPayload);
        creditResult = result;
        if (result.status !== 404) {
          break;
        }
      }

      const finalCreditResult = creditResult ?? {
        ok: false,
        status: 500,
        rawText: '',
        parsed: { message: 'No response from Mayar credit endpoint' },
      };

      upstreamStatus = finalCreditResult.status;
      const parsed = finalCreditResult.parsed;
      const rawText = finalCreditResult.rawText;
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

      if (finalCreditResult.ok && selectedCheckout) {
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
      let invoiceAttempt = await tryCreate('/invoice/create', mayarPayload);

      if (
        !invoiceAttempt.ok &&
        invoiceAttempt.status === 400 &&
        typeof invoiceAttempt.message === 'string' &&
        invoiceAttempt.message.toLowerCase().includes('extradata validation error')
      ) {
        invoiceAttempt = await tryCreate('/invoice/create', stripExtraData(mayarPayload));
      }

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
        let paymentAttempt = await tryCreate('/payment/create', paymentPayload);

        if (
          !paymentAttempt.ok &&
          paymentAttempt.status === 400 &&
          typeof paymentAttempt.message === 'string' &&
          paymentAttempt.message.toLowerCase().includes('extradata validation error')
        ) {
          paymentAttempt = await tryCreate('/payment/create', stripExtraData(paymentPayload));
        }

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
          attemptedUrl,
          upstreamStatus,
          mayarData,
        });
      return NextResponse.json(
        {
          error: 'Failed to create Mayar Invoice',
          details: lastErrorMessage,
          upstreamStatus,
          baseUrl: MAYAR_INTEGRATION_MODE === 'usage_membership' ? MAYAR_CREDIT_BASE_URL : baseUrl,
          attemptedUrl,
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
