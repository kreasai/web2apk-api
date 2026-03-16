import { NextResponse } from 'next/server';
import { createAdminClient, getPricingMap } from '@/lib/supabase/admin';
import { corsHeaders } from '@/lib/cors';
import { normalizeRepoSlug, splitRepoSlug } from '@/lib/github/repo';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const SIGNER_REPO_URL = process.env.SIGNER_REPO_URL || '';
const BUILDER_REPO_URL = process.env.BUILDER_REPO_URL || '';
const SIGNER_WORKFLOW_FILE = process.env.SIGNER_WORKFLOW_FILE || 'sign-release.yml';
const WEB2APK_CALLBACK_TOKEN = process.env.WEB2APK_CALLBACK_TOKEN || '';

function resolveCallbackUrl(req: Request) {
  const configured = process.env.WEB2APK_CALLBACK_URL;
  if (configured) {
    return configured;
  }

  const apiBase = process.env.NEXT_PUBLIC_WEB2APK_API_BASE_URL;
  if (apiBase) {
    return `${apiBase.replace(/\/$/, '')}/api/jobs/callback`;
  }

  const origin = new URL(req.url).origin;
  return `${origin}/api/jobs/callback`;
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
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
      return NextResponse.json({ error: 'Job not found' }, { status: 404, headers: corsHeaders() });
    }

    if (body.userId && body.userId !== job.user_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders() });
    }

    if (job.status !== 'success') {
      return NextResponse.json({ error: 'Job must be success before signing' }, { status: 400, headers: corsHeaders() });
    }

    const pricing = await getPricingMap();
    const signCreditSurcharge = pricing.get('sign_credit_surcharge') ?? 1500;

    const { data: profile } = await admin
      .from('profiles')
      .select('credits')
      .eq('id', job.user_id)
      .single();

    if ((profile?.credits ?? 0) < signCreditSurcharge) {
      return NextResponse.json({ error: 'Insufficient credits for signing' }, { status: 402, headers: corsHeaders() });
    }

    const signerRepoSlug = normalizeRepoSlug(SIGNER_REPO_URL);
    const builderRepoSlug = normalizeRepoSlug(BUILDER_REPO_URL);

    if (!signerRepoSlug || !builderRepoSlug || !GITHUB_TOKEN) {
      return NextResponse.json({ error: 'Signer dispatch env not configured' }, { status: 500, headers: corsHeaders() });
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
      return NextResponse.json({ error: 'Builder artifact metadata missing' }, { status: 400, headers: corsHeaders() });
    }

    const signerDispatch = `https://api.github.com/repos/${signerRepoSlug}/actions/workflows/${SIGNER_WORKFLOW_FILE}/dispatches`;
    const builderSplit = splitRepoSlug(builderRepoSlug);
    const callbackUrl = resolveCallbackUrl(req);

    const baseInputs = {
      job_id: job.id,
      builder_owner: builderSplit.owner,
      builder_repo: builderSplit.name,
      builder_run_id: String(builderMeta.github_run_id),
      builder_artifact_name: String(builderMeta.artifact_name),
      builder_aab_artifact_name: String(builderMeta.artifact_name_aab ?? ''),
    };

    let response = await fetch(signerDispatch, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `token ${GITHUB_TOKEN}`,
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          ...baseInputs,
          callback_url: callbackUrl,
          callback_token: WEB2APK_CALLBACK_TOKEN,
        },
      }),
    });

    if (!response.ok && response.status === 422) {
      response = await fetch(signerDispatch, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `token ${GITHUB_TOKEN}`,
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: baseInputs,
        }),
      });
    }

    if (!response.ok) {
      const text = await response.text();
      await admin
        .from('jobs')
        .update({ status: 'failed', message: `Sign dispatch failed: ${text}` })
        .eq('id', job.id);
      return NextResponse.json({ error: 'Failed to dispatch signer workflow' }, { status: 500, headers: corsHeaders() });
    }

    await admin
      .from('jobs')
      .update({
        status: 'waiting_external',
        message: 'Signer workflow dispatched',
      })
      .eq('id', job.id);

    return NextResponse.json({ success: true, message: 'Signer job dispatched', jobId: job.id }, { headers: corsHeaders() });
  } catch (error) {
    console.error('Sign dispatch error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders() });
  }
}
