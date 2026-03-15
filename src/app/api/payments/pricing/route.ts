import { NextResponse } from 'next/server';
import { getPricingMap } from '@/lib/supabase/admin';
import { corsHeaders } from '@/lib/cors';

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

export async function GET() {
  try {
    const pricing = await getPricingMap();
    const creditPerIdr = pricing.get('credit_per_idr') ?? 0.1;

    if (!creditPerIdr || Number.isNaN(creditPerIdr) || creditPerIdr <= 0) {
      return NextResponse.json(
        {
          error: 'Invalid pricing configuration: credit_per_idr must be greater than 0',
        },
        { status: 500, headers: corsHeaders() },
      );
    }

    const minTopupIdr = Math.floor(
      pricing.get('topup_min_idr') ?? pricing.get('mayar_min_payment_idr') ?? 10_000,
    );
    const maxTopupIdr = Math.floor(
      pricing.get('topup_max_idr') ?? pricing.get('mayar_max_payment_idr') ?? 100_000,
    );

    const minCredits = Math.max(1, Math.ceil(minTopupIdr * creditPerIdr));
    const maxCredits = Math.max(1, Math.floor(maxTopupIdr * creditPerIdr));

    return NextResponse.json(
      {
        creditPerIdr,
        minTopupIdr,
        maxTopupIdr,
        minCredits,
        maxCredits,
      },
      { headers: corsHeaders() },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500, headers: corsHeaders() });
  }
}
