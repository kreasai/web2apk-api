import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { corsHeaders } from '@/lib/cors';

function isMissingAppsTableError(message?: string | null) {
  return Boolean(message?.includes("Could not find the table 'public.apps' in the schema cache"));
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const userId = url.searchParams.get('userId');
    const limitParam = Number(url.searchParams.get('limit') || '50');
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 50;

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400, headers: corsHeaders() });
    }

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('apps')
      .select('id,user_id,name,package_name,icon_path,icon_url,splash_path,splash_url,splash_background_color,base_permissions,base_features,last_version_name,last_version_code,created_at,updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (error) {
      if (isMissingAppsTableError(error.message)) {
        return NextResponse.json(
          {
            error: 'Apps feature is not ready in database. Please run apps migration first.',
            code: 'apps_table_missing',
          },
          { status: 503, headers: corsHeaders() },
        );
      }
      return NextResponse.json({ error: error.message }, { status: 500, headers: corsHeaders() });
    }

    return NextResponse.json({ data: data ?? [] }, { headers: corsHeaders() });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders() });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      userId,
      name,
      packageName,
      iconPath,
      iconUrl,
      splashPath,
      splashUrl,
      splashBackgroundColor,
      basePermissions,
      baseFeatures,
      lastVersionName,
      lastVersionCode,
    } = body as {
      userId?: string;
      name?: string;
      packageName?: string;
      iconPath?: string;
      iconUrl?: string;
      splashPath?: string;
      splashUrl?: string;
      splashBackgroundColor?: string;
      basePermissions?: Record<string, boolean>;
      baseFeatures?: Record<string, boolean>;
      lastVersionName?: string;
      lastVersionCode?: number;
    };

    if (!userId || !name || !packageName || !iconPath || !iconUrl || !splashPath || !splashUrl) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400, headers: corsHeaders() });
    }

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('apps')
      .insert({
        user_id: userId,
        name,
        package_name: packageName,
        icon_path: iconPath ?? null,
        icon_url: iconUrl ?? null,
        splash_path: splashPath ?? null,
        splash_url: splashUrl ?? null,
        splash_background_color: splashBackgroundColor ?? '#0B1220',
        base_permissions: basePermissions ?? {},
        base_features: baseFeatures ?? {},
        last_version_name: lastVersionName ?? '1.0.0',
        last_version_code: lastVersionCode ?? 1,
      })
      .select('id,user_id,name,package_name,icon_path,icon_url,splash_path,splash_url,splash_background_color,base_permissions,base_features,last_version_name,last_version_code,created_at,updated_at')
      .single();

    if (error) {
      if (isMissingAppsTableError(error.message)) {
        return NextResponse.json(
          {
            error: 'Apps feature is not ready in database. Please run apps migration first.',
            code: 'apps_table_missing',
          },
          { status: 503, headers: corsHeaders() },
        );
      }
      return NextResponse.json({ error: error.message }, { status: 500, headers: corsHeaders() });
    }

    return NextResponse.json({ data }, { headers: corsHeaders() });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders() });
  }
}
