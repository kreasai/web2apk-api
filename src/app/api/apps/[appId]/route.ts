import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { corsHeaders } from '@/lib/cors';

function isMissingAppsTableError(message?: string | null) {
  return Boolean(message?.includes("Could not find the table 'public.apps' in the schema cache"));
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

export async function GET(req: Request, context: { params: Promise<{ appId: string }> }) {
  try {
    const { appId } = await context.params;
    const userId = new URL(req.url).searchParams.get('userId');

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400, headers: corsHeaders() });
    }

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('apps')
      .select('id,user_id,name,package_name,source_type,source_path,icon_path,icon_url,splash_path,splash_url,splash_background_color,base_permissions,base_features,last_version_name,last_version_code,created_at,updated_at')
      .eq('id', appId)
      .eq('user_id', userId)
      .single();

    if (isMissingAppsTableError(error?.message)) {
      return NextResponse.json(
        {
          error: 'Apps feature is not ready in database. Please run apps migration first.',
          code: 'apps_table_missing',
        },
        { status: 503, headers: corsHeaders() },
      );
    }

    if (error || !data) {
      return NextResponse.json({ error: 'App not found' }, { status: 404, headers: corsHeaders() });
    }

    return NextResponse.json({ data }, { headers: corsHeaders() });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders() });
  }
}

export async function PATCH(req: Request, context: { params: Promise<{ appId: string }> }) {
  try {
    const { appId } = await context.params;
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
      sourceType,
      sourcePath,
    } = body as {
      userId?: string;
      name?: string;
      packageName?: string;
      iconPath?: string | null;
      iconUrl?: string | null;
      splashPath?: string | null;
      splashUrl?: string | null;
      splashBackgroundColor?: string;
      basePermissions?: Record<string, boolean>;
      baseFeatures?: Record<string, boolean>;
      lastVersionName?: string;
      lastVersionCode?: number;
      sourceType?: 'url' | 'zip' | null;
      sourcePath?: string | null;
    };

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400, headers: corsHeaders() });
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (packageName !== undefined) updates.package_name = packageName;
    if (iconPath !== undefined) updates.icon_path = iconPath;
    if (iconUrl !== undefined) updates.icon_url = iconUrl;
    if (splashPath !== undefined) updates.splash_path = splashPath;
    if (splashUrl !== undefined) updates.splash_url = splashUrl;
    if (splashBackgroundColor !== undefined) updates.splash_background_color = splashBackgroundColor;
    if (basePermissions !== undefined) updates.base_permissions = basePermissions;
    if (baseFeatures !== undefined) updates.base_features = baseFeatures;
    if (lastVersionName !== undefined) updates.last_version_name = lastVersionName;
    if (lastVersionCode !== undefined) updates.last_version_code = lastVersionCode;
    if (sourceType !== undefined) {
      updates.source_type = sourceType === 'url' ? 'url' : null;
      updates.source_path = sourceType === 'url' ? sourcePath ?? null : null;
    }

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('apps')
      .update(updates)
      .eq('id', appId)
      .eq('user_id', userId)
      .select('id,user_id,name,package_name,source_type,source_path,icon_path,icon_url,splash_path,splash_url,splash_background_color,base_permissions,base_features,last_version_name,last_version_code,created_at,updated_at')
      .single();

    if (isMissingAppsTableError(error?.message)) {
      return NextResponse.json(
        {
          error: 'Apps feature is not ready in database. Please run apps migration first.',
          code: 'apps_table_missing',
        },
        { status: 503, headers: corsHeaders() },
      );
    }

    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'App not found' }, { status: 404, headers: corsHeaders() });
    }

    return NextResponse.json({ data }, { headers: corsHeaders() });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders() });
  }
}
