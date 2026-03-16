import { createAdminClient } from '@/lib/supabase/admin';

const callbackToken = process.env.WEB2APK_CALLBACK_TOKEN || '';
const primaryAppAssetsBucket = process.env.NEXT_PUBLIC_APP_ASSETS_BUCKET || 'app-assets';
const sourceAssetsBucket = process.env.SOURCE_UPLOAD_BUCKET || primaryAppAssetsBucket;

function getBucketCandidates(kind: 'app' | 'source') {
  if (kind === 'source') {
    return Array.from(new Set([sourceAssetsBucket, primaryAppAssetsBucket, 'app-assets', 'app_assets', 'images']));
  }
  return Array.from(new Set([primaryAppAssetsBucket, 'app-assets', 'app_assets', 'images']));
}

export function isCallbackTokenValid(url: URL) {
  if (!callbackToken) return true;
  return url.searchParams.get('token') === callbackToken;
}

export function buildUnauthorizedPayload() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function resolveAssetPath(jobId: string, kind: 'icon' | 'splash' | 'source') {
  const admin = createAdminClient();
  const { data: job, error: jobError } = await admin
    .from('jobs')
    .select('id,app_id,source_type,source_path,features')
    .eq('id', jobId)
    .single();

  if (jobError || !job) {
    throw new Error('Job not found');
  }

  const features = (job.features as Record<string, unknown> | null) ?? {};

  if (kind === 'source') {
    if (job.source_type !== 'zip') {
      throw new Error('Source zip not available for this job');
    }
    const path = typeof job.source_path === 'string' ? job.source_path : '';
    if (!path) throw new Error('Source zip path not available');
    return { path, bucketCandidates: getBucketCandidates('source') };
  }

  const featureKey = kind === 'icon' ? '__icon_path' : '__splash_path';
  const featurePath = typeof features[featureKey] === 'string' ? features[featureKey] : '';
  if (featurePath) {
    return { path: featurePath, bucketCandidates: getBucketCandidates('app') };
  }

  if (job.app_id) {
    if (kind === 'icon') {
      const { data: app, error: appError } = await admin
        .from('apps')
        .select('id,icon_path')
        .eq('id', job.app_id)
        .single();

      if (!appError && app && typeof app.icon_path === 'string' && app.icon_path) {
        return { path: app.icon_path, bucketCandidates: getBucketCandidates('app') };
      }
    } else {
      const { data: app, error: appError } = await admin
        .from('apps')
        .select('id,splash_path')
        .eq('id', job.app_id)
        .single();

      if (!appError && app && typeof app.splash_path === 'string' && app.splash_path) {
        return { path: app.splash_path, bucketCandidates: getBucketCandidates('app') };
      }
    }
  }

  throw new Error(`${kind} path not found`);
}

function inferContentType(path: string, fallback = 'application/octet-stream') {
  const normalized = path.toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  if (normalized.endsWith('.webp')) return 'image/webp';
  if (normalized.endsWith('.zip')) return 'application/zip';
  return fallback;
}

export async function downloadAssetBuffer(path: string, bucketCandidates: string[]) {
  if (/^https?:\/\//i.test(path)) {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`Failed to fetch remote asset: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || inferContentType(path);
    return { arrayBuffer, contentType };
  }

  const admin = createAdminClient();
  let lastError = 'Asset not found in storage';

  for (const bucket of bucketCandidates) {
    const { data, error } = await admin.storage.from(bucket).download(path);
    if (!error && data) {
      const arrayBuffer = await data.arrayBuffer();
      const contentType = data.type || inferContentType(path);
      return { arrayBuffer, contentType };
    }
    if (error?.message) {
      lastError = `${bucket}: ${error.message}`;
    }
  }

  throw new Error(lastError);
}
