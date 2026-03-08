import { NextResponse } from 'next/server';
import { createAdminClient, getPricingMap } from '@/lib/supabase/admin';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const SIGNER_REPO_URL = process.env.SIGNER_REPO_URL || '';
const BUILDER_REPO_URL = process.env.BUILDER_REPO_URL || '';
const SIGNER_WORKFLOW_FILE = process.env.SIGNER_WORKFLOW_FILE || 'sign-release.yml';

function splitRepo(repo: string) {
  const [owner, name] = repo.split('/');
  return { owner, name };
}

export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const body = (await req.json().catch(() => ({}))) as { userId?: string };

    const admin = createAdminClient();
    const { data: job, error: jobError } = await admin
      .from('jobs')
      .select('id,user_id,status,apk_url')
      .eq('id', jobId)
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (body.userId && body.userId !== job.user_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (job.status !== 'success') {
      return NextResponse.json({ error: 'Job must be success before signing' }, { status: 400 });
    }

    const pricing = await getPricingMap();
    const signCreditSurcharge = pricing.get('sign_credit_surcharge') ?? 50;

    const { data: profile } = await admin
      .from('profiles')
      .select('credits')
      .eq('id', job.user_id)
      .single();

    if ((profile?.credits ?? 0) < signCreditSurcharge) {
      return NextResponse.json({ error: 'Insufficient credits for signing' }, { status: 402 });
    }

    if (!SIGNER_REPO_URL || !BUILDER_REPO_URL || !GITHUB_TOKEN) {
      return NextResponse.json({ error: 'Signer dispatch env not configured' }, { status: 500 });
    }

    let builderMeta: {
      github_run_id?: string;
      artifact_name?: string;
      artifact_name_aab?: string;
    } = {};

    try {
      builderMeta = job.apk_url ? JSON.parse(job.apk_url) : {};
    } catch {
      builderMeta = {};
    }

    if (!builderMeta.github_run_id || !builderMeta.artifact_name) {
      return NextResponse.json({ error: 'Builder artifact metadata missing' }, { status: 400 });
    }

    const signerDispatch = `https://api.github.com/repos/${SIGNER_REPO_URL}/actions/workflows/${SIGNER_WORKFLOW_FILE}/dispatches`;
    const builderSplit = splitRepo(BUILDER_REPO_URL);

    const response = await fetch(signerDispatch, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `token ${GITHUB_TOKEN}`,
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          job_id: job.id,
          builder_owner: builderSplit.owner,
          builder_repo: builderSplit.name,
          builder_run_id: String(builderMeta.github_run_id),
          builder_artifact_name: String(builderMeta.artifact_name),
          builder_artifact_name_aab: String(builderMeta.artifact_name_aab ?? ''),
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      await admin
        .from('jobs')
        .update({ status: 'failed', message: `Sign dispatch failed: ${text}` })
        .eq('id', job.id);
      return NextResponse.json({ error: 'Failed to dispatch signer workflow' }, { status: 500 });
    }

    await admin
      .from('jobs')
      .update({
        status: 'waiting_external',
        message: 'Signer workflow dispatched',
      })
      .eq('id', job.id);

    return NextResponse.json({ success: true, message: 'Signer job dispatched', jobId: job.id });
  } catch (error) {
    console.error('Sign dispatch error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
