import { NextResponse } from 'next/server';
import {
  buildUnauthorizedPayload,
  downloadAssetBuffer,
  isCallbackTokenValid,
  resolveAssetPath,
} from '@/lib/jobs/assetProxy';

export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const url = new URL(req.url);
  if (!isCallbackTokenValid(url)) {
    return buildUnauthorizedPayload();
  }

  try {
    const { jobId } = await params;
    const { path, bucketCandidates } = await resolveAssetPath(jobId, 'source');
    const { arrayBuffer, contentType } = await downloadAssetBuffer(path, bucketCandidates);

    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=60',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load source';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
