import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createHmac, timingSafeEqual } from 'crypto';

const MAYAR_API_KEY = process.env.MAYAR_API_KEY || '';
const MAYAR_BASE_URL =
  process.env.MAYAR_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://api.mayar.id/hl/v1' : 'https://api.mayar.club/hl/v1');
const MAYAR_WEBHOOK_SECRET = process.env.MAYAR_WEBHOOK_SECRET || '';

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

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();

    if (MAYAR_WEBHOOK_SECRET) {
      const incomingSignature =
        req.headers.get('x-mayar-signature') ||
        req.headers.get('x-signature') ||
        req.headers.get('signature') ||
        '';

      if (!incomingSignature) {
        return NextResponse.json({ error: 'Missing webhook signature' }, { status: 401 });
      }

      const normalizedIncoming = incomingSignature.replace(/^sha256=/i, '').trim();
      const expected = createHmac('sha256', MAYAR_WEBHOOK_SECRET).update(rawBody).digest('hex');
      const incomingBuf = Buffer.from(normalizedIncoming, 'hex');
      const expectedBuf = Buffer.from(expected, 'hex');

      if (incomingBuf.length !== expectedBuf.length || !timingSafeEqual(incomingBuf, expectedBuf)) {
        return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
      }
    }

    const bodyUnknown = rawBody ? JSON.parse(rawBody) : {};
    const body = typeof bodyUnknown === 'object' && bodyUnknown !== null
      ? (bodyUnknown as Record<string, unknown>)
      : {};
    const event = normalizeEvent(body.event ?? body.type);

    const data = typeof body.data === 'object' && body.data !== null
      ? (body.data as Record<string, unknown>)
      : {};
    const statusFromPayload = normalizeStatus(data.status ?? body.status);

    if (!shouldProcessAsPaid(event, statusFromPayload)) {
      return NextResponse.json({ message: 'Event ignored', event, status: statusFromPayload });
    }

    const admin = createAdminClient();

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
          user_id: string;
          credits_added: number;
          status: 'unpaid' | 'paid' | 'expired' | 'closed';
          payment_method: string | null;
        }
      | null = null;

    for (const idCandidate of idCandidates) {
      const { data: txByInvoice } = await admin
        .from('transactions')
        .select('id,user_id,credits_added,status,payment_method')
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
          .select('id,user_id,credits_added,status,payment_method,created_at')
          .eq('user_id', profile.id)
          .eq('status', 'unpaid')
          .eq('amount', Math.floor(amountFromWebhook))
          .in('payment_method', ['mayar', 'mayar_credit'])
          .order('created_at', { ascending: false })
          .limit(2);

        if (fallbackCandidates && fallbackCandidates.length === 1) {
          tx = fallbackCandidates[0];
        } else if (fallbackCandidates && fallbackCandidates.length > 1) {
          const mayarCreditOnly = fallbackCandidates.every((candidate) => candidate.payment_method === 'mayar_credit');

          if (mayarCreditOnly) {
            tx = fallbackCandidates[0];
            const staleIds = fallbackCandidates.slice(1).map((candidate) => candidate.id);
            if (staleIds.length > 0) {
              await admin
                .from('transactions')
                .update({ status: 'expired', updated_at: new Date().toISOString() })
                .in('id', staleIds);
            }
          } else {
            return NextResponse.json({ error: 'Ambiguous transaction match' }, { status: 409 });
          }
        }
      }
    }

    if (!tx) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

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
      return NextResponse.json({ success: true, message: `Invoice ${resolvedStatus}` });
    }

    if (tx.status === 'paid') {
      return NextResponse.json({ success: true, message: 'Already processed' });
    }

    const { data: updatedRows, error: updateTxError } = await admin
      .from('transactions')
      .update({ status: 'paid', amount: amountPaid ?? 0, updated_at: new Date().toISOString() })
      .neq('status', 'paid')
      .eq('id', tx.id)
      .select('id');

    if (updateTxError) {
      return NextResponse.json({ error: updateTxError.message }, { status: 500 });
    }

    if (!updatedRows || updatedRows.length === 0) {
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

    return NextResponse.json({ success: true, message: 'Webhook processed' });

  } catch (error) {
    console.error('Webhook processing error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
