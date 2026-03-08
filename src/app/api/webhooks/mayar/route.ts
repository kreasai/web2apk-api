import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

const MAYAR_API_KEY = process.env.MAYAR_API_KEY || '';
const MAYAR_BASE_URL =
  process.env.MAYAR_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://api.mayar.id/hl/v1' : 'https://api.mayar.club/hl/v1');

// Webhook untuk menerima event pembayaran dari Mayar
// Biasanya di-hit saat event payment.received
export async function POST(req: Request) {
  try {
    const body = await req.json();
    
    if (body.event === 'payment.received') {
      const invoiceData = body.data;
      const invoiceId = invoiceData.id;
      const admin = createAdminClient();

      const verify = await fetch(`${MAYAR_BASE_URL}/invoice/${invoiceId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${MAYAR_API_KEY}`,
        },
      });
      const verifyData = await verify.json();

      if (!verify.ok || !verifyData?.data) {
        return NextResponse.json({ error: 'Failed to verify invoice' }, { status: 400 });
      }

      const invoiceStatus = verifyData.data.status as 'unpaid' | 'paid' | 'expired' | 'closed';
      const amountPaid = verifyData.data.amount ?? invoiceData.amount;
      
      // Ambil extra data yang kita set saat create invoice
      const userId = invoiceData.extraData?.userId;
      const creditsAdded = invoiceData.extraData?.credits;

      if (!userId || !creditsAdded) {
        return NextResponse.json({ error: 'Invalid extra data' }, { status: 400 });
      }

      const { data: tx, error: txError } = await admin
        .from('transactions')
        .select('id,user_id,credits_added,status')
        .eq('invoice_id', invoiceId)
        .single();

      if (txError || !tx) {
        return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
      }

      if (invoiceStatus !== 'paid') {
        await admin
          .from('transactions')
          .update({ status: invoiceStatus, updated_at: new Date().toISOString() })
          .eq('id', tx.id);
        return NextResponse.json({ success: true, message: `Invoice ${invoiceStatus}` });
      }

      if (tx.status === 'paid') {
        return NextResponse.json({ success: true, message: 'Already processed' });
      }

      const { data: updatedRows, error: updateTxError } = await admin
        .from('transactions')
        .update({ status: 'paid', amount: amountPaid, updated_at: new Date().toISOString() })
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

      console.log(`Payment successful for user ${userId}. Invoice ${invoiceId} paid ${amountPaid}. Added ${creditsAdded} credits.`);
      
      return NextResponse.json({ success: true, message: 'Webhook processed' });
    }

    return NextResponse.json({ message: 'Event ignored' });

  } catch (error) {
    console.error('Webhook processing error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
