import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { corsHeaders } from '@/lib/cors';

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const userId = url.searchParams.get('userId');
    const status = url.searchParams.get('status');
    const limitRaw = Number(url.searchParams.get('limit') ?? '20');
    const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 20;

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400, headers: corsHeaders() });
    }

    const admin = createAdminClient();
    let query = admin
      .from('jobs')
      .select(
        'id,user_id,app_id,app_name,package_name,version_name,version_code,source_type,status,message,apk_url,signed_apk_url,created_at,updated_at,expires_at',
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500, headers: corsHeaders() });
    }

    return NextResponse.json({ data: data ?? [] }, { headers: corsHeaders() });
  } catch (error) {
    console.error('List jobs error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders() });
  }
}
