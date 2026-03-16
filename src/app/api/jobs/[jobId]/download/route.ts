import { NextResponse } from 'next/server';
import AdmZip from 'adm-zip';
import { createAdminClient } from '@/lib/supabase/admin';
import { corsHeaders } from '@/lib/cors';
import { normalizeRepoSlug, splitRepoSlug } from '@/lib/github/repo';

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

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

function sanitizeFilePart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildDownloadFileName(params: {
  packageName: string;
  versionName: string;
  fileType: 'apk' | 'aab';
}) {
  const packageName = sanitizeFilePart(params.packageName || 'app');
  const versionName = sanitizeFilePart(params.versionName || '1.0.0');
  return `${packageName}-${versionName}-${params.fileType}-apeka.dev.${params.fileType}`;
}

export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const url = new URL(req.url);
    const userId = url.searchParams.get('userId');
    const fileTypeParam = url.searchParams.get('fileType') ?? 'apk';
    const fileType: 'apk' | 'aab' = fileTypeParam === 'aab' ? 'aab' : 'apk';
    const signed = url.searchParams.get('signed') !== 'false';

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400, headers: corsHeaders() });
    }

    const admin = createAdminClient();
    const { data: job, error: jobError } = await admin
      .from('jobs')
      .select('id,user_id,status,apk_url,signed_apk_url,expires_at,package_name,version_name')
      .eq('id', jobId)
      .eq('user_id', userId)
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404, headers: corsHeaders() });
    }

    if (job.status !== 'success' && job.status !== 'waiting_external') {
      return NextResponse.json({ error: 'Artifact not ready' }, { status: 400, headers: corsHeaders() });
    }

    if (job.expires_at) {
      const expired = Date.now() > new Date(job.expires_at).getTime();
      if (expired) {
        return NextResponse.json({ error: 'Download link expired' }, { status: 410, headers: corsHeaders() });
      }
    }

    const selectedMeta = signed ? parseMeta(job.signed_apk_url) : parseMeta(job.apk_url);
    const runId = selectedMeta.github_run_id;
    const artifactName = fileType === 'aab' ? selectedMeta.artifact_name_aab : selectedMeta.artifact_name;

    if (!runId || !artifactName) {
      return NextResponse.json({ error: 'Artifact metadata missing' }, { status: 400, headers: corsHeaders() });
    }

    const repoRaw = signed ? SIGNER_REPO_URL : BUILDER_REPO_URL;
    const repoSlug = normalizeRepoSlug(repoRaw);
    if (!repoSlug || !GITHUB_TOKEN) {
      return NextResponse.json({
        error: `GitHub download env not configured (repo=${repoRaw || 'empty'})`,
        artifact: { runId, artifactName, signed },
      }, { status: 500, headers: corsHeaders() });
    }

    const { owner, name } = splitRepoSlug(repoSlug);
    const listArtifactsUrl = `https://api.github.com/repos/${owner}/${name}/actions/runs/${runId}/artifacts`;
    const listRes = await fetch(listArtifactsUrl, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `token ${GITHUB_TOKEN}`,
      },
    });

    if (!listRes.ok) {
      const text = await listRes.text();
      return NextResponse.json(
        { error: `Failed to list artifacts: ${text}`, repo: repoSlug, runId, artifactName },
        { status: 500, headers: corsHeaders() },
      );
    }

    const listData = (await listRes.json()) as {
      artifacts?: Array<{ name: string; archive_download_url: string }>;
    };
    const artifact = listData.artifacts?.find((a) => a.name === artifactName);

    if (!artifact) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404, headers: corsHeaders() });
    }

    const downloadRes = await fetch(artifact.archive_download_url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `token ${GITHUB_TOKEN}`,
      },
    });

    if (!downloadRes.ok) {
      const text = await downloadRes.text();
      return NextResponse.json({ error: `Failed to download artifact: ${text}` }, { status: 500, headers: corsHeaders() });
    }

    const archiveBuffer = Buffer.from(await downloadRes.arrayBuffer());
    const zip = new AdmZip(archiveBuffer);
    const entries = zip.getEntries();
    const expectedExtension = fileType === 'aab' ? '.aab' : '.apk';
    const artifactEntry = entries.find((entry: { isDirectory: boolean; entryName: string }) => {
      return !entry.isDirectory && entry.entryName.toLowerCase().endsWith(expectedExtension);
    });

    if (!artifactEntry) {
      return NextResponse.json(
        { error: `Artifact file ${expectedExtension} not found in archive` },
        { status: 404, headers: corsHeaders() },
      );
    }

    const fileBuffer = artifactEntry.getData();
    const fileArrayBuffer = fileBuffer.buffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset + fileBuffer.byteLength,
    ) as ArrayBuffer;
    const downloadName = buildDownloadFileName({
      packageName: job.package_name,
      versionName: job.version_name,
      fileType,
    });

    const res = new NextResponse(fileArrayBuffer, {
      headers: {
        'Content-Type': fileType === 'aab' ? 'application/octet-stream' : 'application/vnd.android.package-archive',
        'Content-Disposition': `attachment; filename="${downloadName}"`,
        'Cache-Control': 'private, no-store, max-age=0',
      },
    });
    
    // Add CORS headers to the stream response
    const headers = corsHeaders();
    for (const [key, value] of Object.entries(headers)) {
      res.headers.set(key, value);
    }
    
    return res;
  } catch (error) {
    console.error('Download endpoint error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders() });
  }
}
