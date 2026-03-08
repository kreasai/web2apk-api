import { NextResponse } from 'next/server';
import { createAdminClient, getPricingMap } from '@/lib/supabase/admin';

const BUILDER_REPO_URL = process.env.BUILDER_REPO_URL || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const BUILDER_WORKFLOW_FILE = process.env.BUILDER_WORKFLOW_FILE || 'android-build.yml';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      userId,
      appName,
      packageName,
      sourceUrl,
      sourceType,
      sourceZip,
      versionName,
      versionCode,
      permissions,
      features,
    } = body as {
      userId?: string;
      appName?: string;
      packageName?: string;
      sourceUrl?: string;
      sourceType?: 'url' | 'zip';
      sourceZip?: string;
      versionName?: string;
      versionCode?: number;
      permissions?: Record<string, boolean>;
      features?: Record<string, boolean>;
    };

    if (!userId || !appName || !packageName || (!sourceUrl && !sourceZip)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const admin = createAdminClient();
    const pricing = await getPricingMap();
    const buildCreditCost = pricing.get('build_credit_cost') ?? 100;

    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('credits')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 404 });
    }

    if ((profile.credits ?? 0) < buildCreditCost) {
      return NextResponse.json({ error: 'Insufficient credits' }, { status: 402 });
    }

    const { data: insertedJob, error: insertJobError } = await admin
      .from('jobs')
      .insert({
        user_id: userId,
        app_name: appName,
        package_name: packageName,
        version_name: versionName ?? '1.0.0',
        version_code: versionCode ?? 1,
        source_type: sourceType ?? (sourceZip ? 'zip' : 'url'),
        source_path: sourceZip || sourceUrl,
        permissions: permissions ?? {},
        features: features ?? {},
        status: 'queued',
        message: 'Job queued',
      })
      .select('id')
      .single();

    if (insertJobError || !insertedJob) {
      return NextResponse.json({ error: insertJobError?.message ?? 'Failed to create job' }, { status: 500 });
    }

    const jobId = insertedJob.id;

    const dispatchUrl = `https://api.github.com/repos/${BUILDER_REPO_URL}/actions/workflows/${BUILDER_WORKFLOW_FILE}/dispatches`;
    
    if (BUILDER_REPO_URL && GITHUB_TOKEN) {
      const response = await fetch(dispatchUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `token ${GITHUB_TOKEN}`,
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            job_id: jobId,
            source_type: sourceType ?? (sourceZip ? 'zip' : 'url'),
            source_url: sourceUrl ?? '',
            source_zip: sourceZip ?? '',
            app_name: appName,
            package_name: packageName,
            version_name: versionName ?? '1.0.0',
            version_code: String(versionCode ?? 1),
            permissions: JSON.stringify(permissions ?? {}),
            features: JSON.stringify(features ?? {}),
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        await admin
          .from('jobs')
          .update({ status: 'failed', message: `Dispatch failed: ${text}` })
          .eq('id', jobId);
        return NextResponse.json({ error: 'Failed to trigger builder workflow' }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true, jobId, message: 'Job queued successfully' });
  } catch (error) {
    console.error('Job creation error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
