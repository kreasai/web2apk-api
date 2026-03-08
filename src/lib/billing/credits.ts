import type { SupabaseClient } from '@supabase/supabase-js';

export async function applyInternalCreditCharge(params: {
  admin: SupabaseClient;
  userId: string;
  jobId: string;
  chargeType: 'build' | 'sign';
  credits: number;
}) {
  const { admin, userId, jobId, chargeType, credits } = params;
  const invoiceId = `charge:${chargeType}:${jobId}`;

  const { error: insertError } = await admin.from('transactions').insert({
    user_id: userId,
    invoice_id: invoiceId,
    amount: 0,
    credits_added: -Math.abs(credits),
    payment_method: 'internal',
    status: 'paid',
    checkout_url: null,
  });

  if (insertError && insertError.code === '23505') {
    return { charged: false, reason: 'already_charged' as const };
  }

  if (insertError) {
    throw new Error(insertError.message);
  }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('credits')
    .eq('id', userId)
    .single();

  if (profileError) {
    throw new Error(profileError.message);
  }

  const nextCredits = Math.max(0, (profile?.credits ?? 0) - Math.abs(credits));
  const { error: updateError } = await admin
    .from('profiles')
    .update({ credits: nextCredits, updated_at: new Date().toISOString() })
    .eq('id', userId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  return { charged: true, reason: 'charged' as const };
}
