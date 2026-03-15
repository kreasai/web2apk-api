import { NextResponse } from 'next/server';
import { createAdminClient, getPricingMap } from '@/lib/supabase/admin';
import { applyInternalCreditCharge } from '@/lib/billing/credits';
import { corsHeaders } from '@/lib/cors';

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

export async function POST(req: Request) {
  try {
    const token =
      req.headers.get('X-WEB2APK-CALLBACK-TOKEN') ||
      req.headers.get('x-web2apk-callback-token');
    
    // Validasi token keamanan (opsional tapi sangat disarankan)
    const expectedToken = process.env.WEB2APK_CALLBACK_TOKEN;
    if (expectedToken && token !== expectedToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rawBody = await req.text();
    let body: Record<string, unknown> = {};

    try {
      body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    } catch {
      const repaired = rawBody.replace(
        /"job_id"\s*:\s*([0-9a-fA-F-]{36})/,
        '"job_id":"$1"',
      );
      try {
        body = repaired ? (JSON.parse(repaired) as Record<string, unknown>) : {};
      } catch {
        return NextResponse.json({ error: 'Invalid callback payload' }, { status: 400 });
      }
    }
    const job_id = typeof body.job_id === 'string' ? body.job_id : '';
    const status = typeof body.status === 'string' ? body.status : '';
    const stage = typeof body.stage === 'string' ? body.stage : '';
    const progress = typeof body.progress === 'number' ? body.progress : Number(body.progress ?? 0);
    const error_message = typeof body.error_message === 'string' ? body.error_message : '';
    const github_run_id =
      typeof body.github_run_id === 'number' || typeof body.github_run_id === 'string'
        ? Number(body.github_run_id)
        : null;
    const artifact_name = typeof body.artifact_name === 'string' ? body.artifact_name : '';
    const artifact_name_aab = typeof body.artifact_name_aab === 'string' ? body.artifact_name_aab : '';

    if (!job_id || !status) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    const admin = createAdminClient();
    const { data: job, error: jobError } = await admin
      .from('jobs')
      .select('id,user_id,status,message,apk_url,signed_apk_url')
      .eq('id', job_id)
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    const pricing = await getPricingMap();
    const buildCreditCost = pricing.get('build_credit_cost') ?? 1000;
    const signCreditSurcharge = pricing.get('sign_credit_surcharge') ?? 1500;

    const nextMessage = error_message || `Stage ${stage || 'unknown'}: ${status}`;

    const nextUpdate: {
      status: string;
      message: string;
      updated_at: string;
      apk_url?: string;
      signed_apk_url?: string;
      expires_at?: string;
    } = {
      status,
      message: nextMessage,
      updated_at: new Date().toISOString(),
    };

    if (stage === 'builder' && status === 'success') {
      nextUpdate.apk_url = JSON.stringify({
        github_run_id,
        artifact_name,
        artifact_name_aab,
      });
      nextUpdate.expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    }

    if (stage === 'signer' && status === 'success') {
      nextUpdate.signed_apk_url = JSON.stringify({
        github_run_id,
        artifact_name,
        artifact_name_aab,
      });
    }

    const { data: updatedRows, error: updateError } = await admin
      .from('jobs')
      .update(nextUpdate)
      .eq('id', job_id)
      .select('id');

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    if (!updatedRows || updatedRows.length === 0) {
      return NextResponse.json({ error: 'Job update not applied' }, { status: 404 });
    }

    if (status === 'success' && stage === 'builder') {
      const charge = await applyInternalCreditCharge({
        admin,
        userId: job.user_id,
        jobId: job.id,
        chargeType: 'build',
        credits: buildCreditCost,
      });

      if (charge.charged) {
        await admin
          .from('jobs')
          .update({ message: `${nextMessage} [build_charged]` })
          .eq('id', job_id);
      }
    }

    if (status === 'success' && stage === 'signer') {
      const charge = await applyInternalCreditCharge({
        admin,
        userId: job.user_id,
        jobId: job.id,
        chargeType: 'sign',
        credits: signCreditSurcharge,
      });

      if (charge.charged) {
        await admin
          .from('jobs')
          .update({ message: `${nextMessage} [sign_charged]` })
          .eq('id', job_id);
      }
    }

    console.log(`[Callback] Job ${job_id} | Stage: ${stage} | Status: ${status} | Progress: ${progress}%`);
    const artifactMeta = { github_run_id, artifact_name, artifact_name_aab };
    console.log(`[Callback Artifact Meta] ${JSON.stringify(artifactMeta)}`);

    if (error_message) {
      console.error(`[Callback Error] Job ${job_id}: ${error_message}`);
    }

    return NextResponse.json({ success: true, message: 'Callback processed successfully' });
  } catch (error) {
    console.error('Callback processing error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
