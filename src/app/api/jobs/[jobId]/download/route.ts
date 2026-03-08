import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const BUILDER_REPO_URL = process.env.BUILDER_REPO_URL || '';
const SIGNER_REPO_URL = process.env.SIGNER_REPO_URL || '';

type ArtifactMeta = {
  github_run_id?: string;
  artifact_name?: string;
  artifact_name_aab?: string;
};

function parseMeta(value: string | null): ArtifactMeta {
  if (!value) return {};
  try {
    return JSON.parse(value) as ArtifactMeta;
  } catch {
    return {};
  }
}

function splitRepo(repo: string) {
  const [owner, name] = repo.split('/');
  return { owner, name };
}

export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const url = new URL(req.url);
    const userId = url.searchParams.get('userId');
    const fileType = url.searchParams.get('fileType') ?? 'apk';
    const signed = url.searchParams.get('signed') !== 'false';

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    const admin = createAdminClient();
    const { data: job, error: jobError } = await admin
      .from('jobs')
      .select('id,user_id,status,apk_url,signed_apk_url,expires_at')
      .eq('id', jobId)
      .eq('user_id', userId)
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (job.status !== 'success' && job.status !== 'waiting_external') {
      return NextResponse.json({ error: 'Artifact not ready' }, { status: 400 });
    }

    if (job.expires_at) {
      const expired = Date.now() > new Date(job.expires_at).getTime();
      if (expired) {
        return NextResponse.json({ error: 'Download link expired' }, { status: 410 });
      }
    }

    const selectedMeta = signed ? parseMeta(job.signed_apk_url) : parseMeta(job.apk_url);
    const runId = selectedMeta.github_run_id;
    const artifactName = fileType === 'aab' ? selectedMeta.artifact_name_aab : selectedMeta.artifact_name;

    if (!runId || !artifactName) {
      return NextResponse.json({ error: 'Artifact metadata missing' }, { status: 400 });
    }

    const repo = signed ? SIGNER_REPO_URL : BUILDER_REPO_URL;
    if (!repo || !GITHUB_TOKEN) {
      return NextResponse.json({
        error: 'GitHub download env not configured',
        artifact: { runId, artifactName, signed },
      }, { status: 500 });
    }

    const { owner, name } = splitRepo(repo);
    const listArtifactsUrl = `https://api.github.com/repos/${owner}/${name}/actions/runs/${runId}/artifacts`;
    const listRes = await fetch(listArtifactsUrl, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `token ${GITHUB_TOKEN}`,
      },
    });

    if (!listRes.ok) {
      const text = await listRes.text();
      return NextResponse.json({ error: `Failed to list artifacts: ${text}` }, { status: 500 });
    }

    const listData = (await listRes.json()) as {
      artifacts?: Array<{ name: string; archive_download_url: string }>;
    };
    const artifact = listData.artifacts?.find((a) => a.name === artifactName);

    if (!artifact) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
    }

    const downloadRes = await fetch(artifact.archive_download_url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `token ${GITHUB_TOKEN}`,
      },
    });

    if (!downloadRes.ok || !downloadRes.body) {
      const text = await downloadRes.text();
      return NextResponse.json({ error: `Failed to download artifact: ${text}` }, { status: 500 });
    }

    return new NextResponse(downloadRes.body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${artifactName}.zip"`,
        'Cache-Control': 'private, no-store, max-age=0',
      },
    });
  } catch (error) {
    console.error('Download endpoint error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
