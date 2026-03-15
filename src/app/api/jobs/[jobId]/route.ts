import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { corsHeaders } from '@/lib/cors';

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const userId = new URL(req.url).searchParams.get('userId');

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400, headers: corsHeaders() });
    }

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('jobs')
      .select('id,user_id,app_id,app_name,package_name,version_name,version_code,source_type,source_path,permissions,features,status,message,apk_url,signed_apk_url,expires_at,created_at,updated_at')
      .eq('id', jobId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404, headers: corsHeaders() });
    }

    return NextResponse.json({ data }, { headers: corsHeaders() });
  } catch (error) {
    console.error('Get job detail error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders() });
  }
}
