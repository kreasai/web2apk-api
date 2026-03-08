import { NextResponse } from 'next/server';
import { createAdminClient, getPricingMap } from '@/lib/supabase/admin';
import { applyInternalCreditCharge } from '@/lib/billing/credits';

export async function POST(req: Request) {
  try {
    // Dipanggil oleh curl dari GitHub Actions Runner (builder-public / signer-private)
    const token = req.headers.get('X-WEB2APK-CALLBACK-TOKEN');
    
    // Validasi token keamanan (opsional tapi sangat disarankan)
    const expectedToken = process.env.WEB2APK_CALLBACK_TOKEN;
    if (expectedToken && token !== expectedToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { 
      job_id, 
      status, 
      stage, 
      progress, 
      error_message, 
      github_run_id,
      artifact_name,
      artifact_name_aab,
    } = body;

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
    const buildCreditCost = pricing.get('build_credit_cost') ?? 100;
    const signCreditSurcharge = pricing.get('sign_credit_surcharge') ?? 50;

    const nextMessage = error_message || `Stage ${stage}: ${status}`;

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
