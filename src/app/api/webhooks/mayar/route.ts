import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createHmac, timingSafeEqual } from 'crypto';

const MAYAR_API_KEY = process.env.MAYAR_API_KEY || '';
const MAYAR_BASE_URL =
  process.env.MAYAR_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://api.mayar.id/hl/v1' : 'https://api.mayar.club/hl/v1');
const MAYAR_WEBHOOK_SECRET = process.env.MAYAR_WEBHOOK_SECRET || '';

type WebhookLogInput = {
  transactionId?: string | null;
  invoiceId?: string | null;
  eventName: string;
  eventStatus: string;
  signatureValid: boolean | null;
  processingResult: string;
  errorMessage?: string | null;
  payload: Record<string, unknown>;
};

function normalizeEvent(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeStatus(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function shouldProcessAsPaid(event: string, status: string) {
  const paidEventAliases = new Set([
    'payment.received',
    'payment.paid',
    'payment.success',
    'invoice.paid',
    'invoice.payment_received',
    'checkout.paid',
    'payment_link.paid',
    'payment-link.paid',
  ]);

  if (paidEventAliases.has(event)) {
    return true;
  }

  if (!event && ['paid', 'success', 'settled', 'completed'].includes(status)) {
    return true;
  }

  return false;
}

function safeEqualBuffer(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeEqualString(a: string, b: string) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return safeEqualBuffer(aBuf, bBuf);
}

function verifyWebhookSignature(rawBody: string, secret: string, signatureHeader: string) {
  const trimmed = signatureHeader.trim();
  const normalizedIncoming = trimmed
    .replace(/^sha256=/i, '')
    .replace(/^bearer\s+/i, '')
    .replace(/^token\s+/i, '')
    .trim();

  if (normalizedIncoming && safeEqualString(normalizedIncoming, secret.trim())) {
    return true;
  }

  const digest = createHmac('sha256', secret).update(rawBody).digest();
  const expectedHex = digest.toString('hex');
  const expectedBase64 = digest.toString('base64');

  const incomingHexCandidate = normalizedIncoming.toLowerCase();
  const isHex = /^[0-9a-f]+$/i.test(incomingHexCandidate);

  if (isHex) {
    const incomingHexBuf = Buffer.from(incomingHexCandidate, 'hex');
    const expectedHexBuf = Buffer.from(expectedHex, 'hex');
    if (safeEqualBuffer(incomingHexBuf, expectedHexBuf)) {
      return true;
    }
  }

  const incomingBase64Buf = Buffer.from(normalizedIncoming);
  const expectedBase64Buf = Buffer.from(expectedBase64);
  return safeEqualBuffer(incomingBase64Buf, expectedBase64Buf);
}

function pickHeader(req: Request, candidates: string[]) {
  for (const key of candidates) {
    const value = req.headers.get(key);
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return '';
}

async function insertWebhookLog(input: WebhookLogInput) {
  const admin = createAdminClient();
  await admin.from('transaction_webhook_logs').insert({
    transaction_id: input.transactionId ?? null,
    invoice_id: input.invoiceId ?? null,
    provider: 'mayar',
    event_name: input.eventName || null,
    event_status: input.eventStatus || null,
    signature_valid: input.signatureValid,
    processing_result: input.processingResult,
    error_message: input.errorMessage ?? null,
    payload: input.payload,
    processed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    let bodyUnknown: unknown = {};
    try {
      bodyUnknown = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      bodyUnknown = {};
    }
    const body = typeof bodyUnknown === 'object' && bodyUnknown !== null
      ? (bodyUnknown as Record<string, unknown>)
      : {};
    const event = normalizeEvent(body.event ?? body.type);
    const data = typeof body.data === 'object' && body.data !== null
      ? (body.data as Record<string, unknown>)
      : {};
    const statusFromPayload = normalizeStatus(data.status ?? body.status);

    const idCandidates = [
      data.id,
      data.invoiceId,
      data.paymentLinkId,
      data.paymentId,
      data.invoice_id,
      data.invoice_number,
      data.externalId,
      data.external_id,
      data.referenceId,
      data.reference_id,
      data.orderId,
      data.order_id,
      data.transactionId,
      data.transaction_id,
      typeof data.invoice === 'object' && data.invoice !== null
        ? (data.invoice as Record<string, unknown>).id
        : null,
      typeof data.paymentLink === 'object' && data.paymentLink !== null
        ? (data.paymentLink as Record<string, unknown>).id
        : null,
      typeof data.invoice === 'object' && data.invoice !== null
        ? (data.invoice as Record<string, unknown>).invoiceId
        : null,
      typeof data.payment === 'object' && data.payment !== null
        ? (data.payment as Record<string, unknown>).id
        : null,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const primaryInvoiceId = idCandidates[0] ?? null;

    let signatureValid: boolean | null = null;

    if (!MAYAR_WEBHOOK_SECRET.trim()) {
      await insertWebhookLog({
        invoiceId: primaryInvoiceId,
        eventName: event,
        eventStatus: statusFromPayload,
        signatureValid: null,
        processingResult: 'webhook_secret_missing',
        errorMessage: 'Webhook secret is not configured',
        payload: body,
      });
      return NextResponse.json({ error: 'Webhook secret is not configured' }, { status: 500 });
    }

    const incomingSignature = pickHeader(req, [
      'x-mayar-signature',
      'x-mayar-token',
      'x-webhook-token',
      'x-callback-token',
      'webhook-token',
      'mayar-token',
      'x-signature',
      'signature',
      'x-webhook-signature',
      'x-callback-signature',
      'mayar-signature',
      'webhook-signature',
      'x-mayar-hmac',
      'authorization',
    ]);

    if (!incomingSignature) {
      signatureValid = false;
      await insertWebhookLog({
        invoiceId: primaryInvoiceId,
        eventName: event,
        eventStatus: statusFromPayload,
        signatureValid,
        processingResult: 'signature_missing',
        errorMessage: 'Missing webhook signature',
        payload: body,
      });
      return NextResponse.json({ error: 'Missing webhook signature' }, { status: 401 });
    }

    if (!verifyWebhookSignature(rawBody, MAYAR_WEBHOOK_SECRET, incomingSignature)) {
      signatureValid = false;
      await insertWebhookLog({
        invoiceId: primaryInvoiceId,
        eventName: event,
        eventStatus: statusFromPayload,
        signatureValid,
        processingResult: 'signature_invalid',
        errorMessage: 'Invalid webhook signature',
        payload: body,
      });
      return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
    }
    signatureValid = true;

    if (!shouldProcessAsPaid(event, statusFromPayload)) {
      await insertWebhookLog({
        invoiceId: primaryInvoiceId,
        eventName: event,
        eventStatus: statusFromPayload,
        signatureValid,
        processingResult: 'event_ignored',
        errorMessage: 'Event ignored',
        payload: body,
      });
      return NextResponse.json({ message: 'Event ignored', event, status: statusFromPayload });
    }

    const admin = createAdminClient();

    const amountFromWebhook = Number(
      typeof data.amount === 'number' || typeof data.amount === 'string'
        ? data.amount
        : typeof data.total === 'number' || typeof data.total === 'string'
          ? data.total
          : 0,
    );
    const customerEmail =
      (typeof data.customerEmail === 'string' && data.customerEmail) ||
      (typeof data.email === 'string' && data.email) ||
      (typeof data.customer_email === 'string' && data.customer_email) ||
      (typeof data.customer === 'object' && data.customer !== null && typeof (data.customer as Record<string, unknown>).email === 'string'
        ? ((data.customer as Record<string, unknown>).email as string)
        : '') ||
      '';
    const normalizedCustomerEmail = customerEmail.trim().toLowerCase();

    let tx:
      | {
          id: string;
          invoice_id: string;
          user_id: string;
          credits_added: number;
          status: 'unpaid' | 'paid' | 'expired' | 'closed';
          payment_method: string | null;
        }
      | null = null;

    for (const idCandidate of idCandidates) {
      const { data: txByInvoice } = await admin
        .from('transactions')
        .select('id,invoice_id,user_id,credits_added,status,payment_method')
        .eq('invoice_id', idCandidate)
        .maybeSingle();
      if (txByInvoice) {
        tx = txByInvoice;
        break;
      }
    }

    if (!tx && normalizedCustomerEmail && Number.isFinite(amountFromWebhook) && amountFromWebhook > 0) {
      const { data: profile } = await admin
        .from('profiles')
        .select('id')
        .ilike('email', normalizedCustomerEmail)
        .maybeSingle();

      if (profile?.id) {
        const { data: fallbackCandidates } = await admin
          .from('transactions')
          .select('id,invoice_id,user_id,credits_added,status,payment_method,created_at')
          .eq('user_id', profile.id)
          .eq('status', 'unpaid')
          .eq('amount', Math.floor(amountFromWebhook))
          .in('payment_method', ['mayar', 'mayar_credit'])
          .order('created_at', { ascending: false })
          .limit(2);

        if (fallbackCandidates && fallbackCandidates.length === 1) {
          tx = fallbackCandidates[0];
        } else if (fallbackCandidates && fallbackCandidates.length > 1) {
          const sortedCandidates = [...fallbackCandidates].sort((a, b) => {
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          });

          tx = sortedCandidates.find((candidate) => candidate.payment_method === 'mayar_credit') ?? sortedCandidates[0];

          const staleIds = sortedCandidates
            .filter((candidate) => candidate.id !== tx?.id)
            .map((candidate) => candidate.id);

          if (staleIds.length > 0) {
            await admin
              .from('transactions')
              .update({ status: 'expired', updated_at: new Date().toISOString() })
              .in('id', staleIds);
          }
        }
      }
    }

    if (!tx) {
      await insertWebhookLog({
        invoiceId: primaryInvoiceId,
        eventName: event,
        eventStatus: statusFromPayload,
        signatureValid,
        processingResult: 'transaction_not_found',
        errorMessage: 'Transaction not found',
        payload: body,
      });
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    const resolvedInvoiceId = tx.invoice_id || primaryInvoiceId;

    let resolvedStatus: 'unpaid' | 'paid' | 'expired' | 'closed' = 'paid';
    let amountPaid = Number.isFinite(amountFromWebhook) && amountFromWebhook > 0 ? Math.floor(amountFromWebhook) : null;

    const shouldVerifyInvoice =
      tx.payment_method === 'mayar' &&
      idCandidates.length > 0 &&
      MAYAR_API_KEY.length > 0;

    if (shouldVerifyInvoice) {
      const verify = await fetch(`${MAYAR_BASE_URL.replace(/\/$/, '')}/invoice/${idCandidates[0]}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${MAYAR_API_KEY}`,
        },
      });
      const verifyRaw = await verify.text();
      let verifyData: Record<string, unknown> | null = null;
      try {
        verifyData = verifyRaw ? (JSON.parse(verifyRaw) as Record<string, unknown>) : null;
      } catch {
        verifyData = null;
      }

      const verifiedData = verifyData && typeof verifyData.data === 'object' && verifyData.data !== null
        ? (verifyData.data as Record<string, unknown>)
        : null;
      const verifiedStatus = typeof verifiedData?.status === 'string' ? verifiedData.status : '';
      const verifiedAmount = Number(
        typeof verifiedData?.amount === 'number' || typeof verifiedData?.amount === 'string'
          ? verifiedData.amount
          : 0,
      );

      if (verify.ok && verifiedData) {
        if (verifiedStatus === 'paid' || verifiedStatus === 'unpaid' || verifiedStatus === 'expired' || verifiedStatus === 'closed') {
          resolvedStatus = verifiedStatus;
        }
        if (Number.isFinite(verifiedAmount) && verifiedAmount > 0) {
          amountPaid = Math.floor(verifiedAmount);
        }
      }
    }

    if (resolvedStatus !== 'paid') {
      await admin
        .from('transactions')
        .update({ status: resolvedStatus, updated_at: new Date().toISOString() })
        .eq('id', tx.id);
      await insertWebhookLog({
        transactionId: tx.id,
        invoiceId: resolvedInvoiceId,
        eventName: event,
        eventStatus: statusFromPayload,
        signatureValid,
        processingResult: `invoice_${resolvedStatus}`,
        errorMessage: null,
        payload: body,
      });
      return NextResponse.json({ success: true, message: `Invoice ${resolvedStatus}` });
    }

    if (tx.status === 'paid') {
      await insertWebhookLog({
        transactionId: tx.id,
        invoiceId: resolvedInvoiceId,
        eventName: event,
        eventStatus: statusFromPayload,
        signatureValid,
        processingResult: 'already_processed',
        errorMessage: null,
        payload: body,
      });
      return NextResponse.json({ success: true, message: 'Already processed' });
    }

    const { data: updatedRows, error: updateTxError } = await admin
      .from('transactions')
      .update({ status: 'paid', amount: amountPaid ?? 0, updated_at: new Date().toISOString() })
      .neq('status', 'paid')
      .eq('id', tx.id)
      .select('id');

    if (updateTxError) {
      await insertWebhookLog({
        transactionId: tx.id,
        invoiceId: resolvedInvoiceId,
        eventName: event,
        eventStatus: statusFromPayload,
        signatureValid,
        processingResult: 'transaction_update_error',
        errorMessage: updateTxError.message,
        payload: body,
      });
      return NextResponse.json({ error: updateTxError.message }, { status: 500 });
    }

    if (!updatedRows || updatedRows.length === 0) {
      await insertWebhookLog({
        transactionId: tx.id,
        invoiceId: resolvedInvoiceId,
        eventName: event,
        eventStatus: statusFromPayload,
        signatureValid,
        processingResult: 'already_processed',
        errorMessage: null,
        payload: body,
      });
      return NextResponse.json({ success: true, message: 'Already processed' });
    }

    const { error: profileError } = await admin.rpc('increment_profile_credits', {
      p_user_id: tx.user_id,
      p_amount: tx.credits_added,
    });

    if (profileError) {
      const { data: profile } = await admin
        .from('profiles')
        .select('credits')
        .eq('id', tx.user_id)
        .single();
      const nextCredits = (profile?.credits ?? 0) + tx.credits_added;
      await admin
        .from('profiles')
        .update({ credits: nextCredits, updated_at: new Date().toISOString() })
        .eq('id', tx.user_id);
    }

    await insertWebhookLog({
      transactionId: tx.id,
      invoiceId: resolvedInvoiceId,
      eventName: event,
      eventStatus: statusFromPayload,
      signatureValid,
      processingResult: 'webhook_processed',
      errorMessage: null,
      payload: body,
    });

    return NextResponse.json({ success: true, message: 'Webhook processed' });

  } catch (error) {
    console.error('Webhook processing error:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    await insertWebhookLog({
      eventName: 'unknown',
      eventStatus: 'error',
      signatureValid: null,
      processingResult: 'internal_error',
      errorMessage: message,
      payload: {},
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
