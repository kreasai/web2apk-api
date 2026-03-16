import { NextResponse } from 'next/server';
import { createAdminClient, getPricingMap } from '@/lib/supabase/admin';
import { corsHeaders } from '@/lib/cors';
import { normalizeRepoSlug } from '@/lib/github/repo';

const BUILDER_REPO_URL = process.env.BUILDER_REPO_URL || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const BUILDER_WORKFLOW_FILE = process.env.BUILDER_WORKFLOW_FILE || 'android-build.yml';
const BUILDER_WORKFLOW_REF = process.env.BUILDER_WORKFLOW_REF || 'main';
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

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      userId,
      appId,
      saveToApp,
      appName,
      packageName,
      sourceUrl,
      sourceType,
      sourceZip,
      iconPath,
      iconUrl,
      splashPath,
      splashUrl,
      splashBackgroundColor,
      versionName,
      versionCode,
      permissions,
      features,
    } = body as {
      userId?: string;
      appId?: string;
      saveToApp?: boolean;
      appName?: string;
      packageName?: string;
      sourceUrl?: string;
      sourceType?: 'url' | 'zip';
      sourceZip?: string;
      iconPath?: string | null;
      iconUrl?: string | null;
      splashPath?: string | null;
      splashUrl?: string | null;
      splashBackgroundColor?: string;
      versionName?: string;
      versionCode?: number;
      permissions?: Record<string, boolean>;
      features?: Record<string, boolean>;
    };

    if (!userId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400, headers: corsHeaders() });
    }

    const admin = createAdminClient();
    const shouldPersistApp = Boolean(appId || saveToApp);

    const isMissingAppsTableError = (message?: string | null) =>
      Boolean(message?.includes("Could not find the table 'public.apps' in the schema cache"));

    let existingApp:
      | {
          id: string;
          name: string;
          package_name: string;
          icon_path: string | null;
          splash_path: string | null;
          splash_background_color: string | null;
          base_permissions: Record<string, boolean>;
          base_features: Record<string, boolean>;
          last_version_name: string;
          last_version_code: number;
        }
      | null = null;

    if (appId) {
      const { data: appData, error: appError } = await admin
        .from('apps')
        .select('id,name,package_name,icon_path,splash_path,splash_background_color,base_permissions,base_features,last_version_name,last_version_code')
        .eq('id', appId)
        .eq('user_id', userId)
        .single();

      if (isMissingAppsTableError(appError?.message)) {
        return NextResponse.json(
          {
            error: 'Apps feature is not ready in database. Please run apps migration first.',
            code: 'apps_table_missing',
          },
          { status: 503, headers: corsHeaders() },
        );
      }

      if (appError || !appData) {
        return NextResponse.json({ error: 'App not found' }, { status: 404, headers: corsHeaders() });
      }
      existingApp = {
        id: appData.id,
        name: appData.name,
        package_name: appData.package_name,
        icon_path: appData.icon_path,
        splash_path: appData.splash_path,
        splash_background_color: appData.splash_background_color,
        base_permissions: (appData.base_permissions as Record<string, boolean>) ?? {},
        base_features: (appData.base_features as Record<string, boolean>) ?? {},
        last_version_name: appData.last_version_name,
        last_version_code: appData.last_version_code,
      };
    }

    const effectiveAppName = appName || existingApp?.name;
    const effectivePackageName = packageName || existingApp?.package_name;
    const effectiveSourceType = sourceType ?? (sourceZip ? 'zip' : sourceUrl ? 'url' : undefined);
    const effectiveSourcePath = sourceZip || sourceUrl;
    const effectiveVersionName = versionName ?? existingApp?.last_version_name ?? '1.0.0';
    const effectiveVersionCode = versionCode ?? existingApp?.last_version_code ?? 1;
    const effectivePermissions = permissions ?? existingApp?.base_permissions ?? {};
    const effectiveFeatures = features ?? existingApp?.base_features ?? {};
    const effectiveIconPath = iconPath ?? existingApp?.icon_path ?? null;
    const effectiveSplashPath = splashPath ?? existingApp?.splash_path ?? null;
    const effectiveSplashBackgroundColor = splashBackgroundColor ?? existingApp?.splash_background_color ?? '#0B1220';
    const effectiveJobFeatures = {
      ...effectiveFeatures,
      enable_swipe_refresh: Boolean(effectiveFeatures.swipeRefresh ?? true),
      enable_external_apps: true,
      enable_offline_page: Boolean(effectiveFeatures.offlinePage ?? true),
      enable_back_navigation: true,
      enable_splash: Boolean(effectiveSplashPath || effectiveIconPath),
      splash_background_color: effectiveSplashBackgroundColor,
      __icon_path: effectiveIconPath ?? '',
      __splash_path: effectiveSplashPath ?? '',
    };

    if (!effectiveAppName || !effectivePackageName || !effectiveSourceType || !effectiveSourcePath) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400, headers: corsHeaders() });
    }

    const pricing = await getPricingMap();
    const buildCreditCost = pricing.get('build_credit_cost') ?? 1000;

    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('credits')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 404, headers: corsHeaders() });
    }

    if ((profile.credits ?? 0) < buildCreditCost) {
      return NextResponse.json({ error: 'Insufficient credits' }, { status: 402, headers: corsHeaders() });
    }

    let resolvedAppId = existingApp?.id ?? null;
    if (resolvedAppId) {
      const { error: updateAppError } = await admin
        .from('apps')
        .update({
          name: effectiveAppName,
          package_name: effectivePackageName,
          ...(iconPath !== undefined ? { icon_path: iconPath } : {}),
          ...(iconUrl !== undefined ? { icon_url: iconUrl } : {}),
          ...(splashPath !== undefined ? { splash_path: splashPath } : {}),
          ...(splashUrl !== undefined ? { splash_url: splashUrl } : {}),
          ...(splashBackgroundColor !== undefined ? { splash_background_color: splashBackgroundColor } : {}),
          base_permissions: effectivePermissions,
          base_features: effectiveFeatures,
          last_version_name: effectiveVersionName,
          last_version_code: effectiveVersionCode,
          updated_at: new Date().toISOString(),
        })
        .eq('id', resolvedAppId)
        .eq('user_id', userId);

      if (isMissingAppsTableError(updateAppError?.message)) {
        return NextResponse.json(
          {
            error: 'Apps feature is not ready in database. Please run apps migration first.',
            code: 'apps_table_missing',
          },
          { status: 503, headers: corsHeaders() },
        );
      }

      if (updateAppError) {
        return NextResponse.json({ error: updateAppError.message }, { status: 500, headers: corsHeaders() });
      }
    } else if (shouldPersistApp) {
      const { data: newApp, error: createAppError } = await admin
        .from('apps')
        .insert({
          user_id: userId,
          name: effectiveAppName,
          package_name: effectivePackageName,
          icon_path: iconPath ?? null,
          icon_url: iconUrl ?? null,
          splash_path: splashPath ?? null,
          splash_url: splashUrl ?? null,
          splash_background_color: splashBackgroundColor ?? '#0B1220',
          base_permissions: effectivePermissions,
          base_features: effectiveFeatures,
          last_version_name: effectiveVersionName,
          last_version_code: effectiveVersionCode,
        })
        .select('id')
        .single();

      if (isMissingAppsTableError(createAppError?.message)) {
        return NextResponse.json(
          {
            error: 'Apps feature is not ready in database. Please run apps migration first.',
            code: 'apps_table_missing',
          },
          { status: 503, headers: corsHeaders() },
        );
      }

      if (createAppError || !newApp) {
        return NextResponse.json({ error: createAppError?.message ?? 'Failed to create app' }, { status: 500, headers: corsHeaders() });
      }
      resolvedAppId = newApp.id;
    }

    const { data: insertedJob, error: insertJobError } = await admin
      .from('jobs')
      .insert({
        user_id: userId,
        app_id: resolvedAppId,
        app_name: effectiveAppName,
        package_name: effectivePackageName,
        version_name: effectiveVersionName,
        version_code: effectiveVersionCode,
        source_type: effectiveSourceType,
        source_path: effectiveSourcePath,
        permissions: effectivePermissions,
         features: effectiveJobFeatures,
         status: 'queued',
         message: 'Job queued',
       })
      .select('id')
      .single();

    if (insertJobError || !insertedJob) {
      return NextResponse.json({ error: insertJobError?.message ?? 'Failed to create job' }, { status: 500, headers: corsHeaders() });
    }

    const jobId = insertedJob.id;
    const callbackUrl = resolveCallbackUrl(req);

    const builderRepoSlug = normalizeRepoSlug(BUILDER_REPO_URL);
    const dispatchUrl = `https://api.github.com/repos/${builderRepoSlug}/actions/workflows/${BUILDER_WORKFLOW_FILE}/dispatches`;
    
    if (builderRepoSlug && GITHUB_TOKEN) {
      const baseInputs = {
        job_id: jobId,
        source_type: effectiveSourceType,
        source_url: effectiveSourceType === 'url' ? effectiveSourcePath : '',
        source_zip_path: effectiveSourceType === 'zip' ? effectiveSourcePath : '',
        app_name: effectiveAppName,
        package_name: effectivePackageName,
        version_name: effectiveVersionName,
        version_code: String(effectiveVersionCode),
        permissions: JSON.stringify(effectivePermissions),
        features: JSON.stringify(effectiveJobFeatures),
        icon_path: effectiveIconPath ?? '',
        splash_path: effectiveSplashPath ?? '',
      };

      let response = await fetch(dispatchUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `token ${GITHUB_TOKEN}`,
        },
        body: JSON.stringify({
            ref: BUILDER_WORKFLOW_REF,
            inputs: {
              ...baseInputs,
              callback_url: callbackUrl,
              callback_token: WEB2APK_CALLBACK_TOKEN,
            },
        }),
      });

      if (!response.ok && response.status === 422) {
        response = await fetch(dispatchUrl, {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `token ${GITHUB_TOKEN}`,
          },
          body: JSON.stringify({
              ref: BUILDER_WORKFLOW_REF,
              inputs: baseInputs,
            }),
          });
      }

      if (!response.ok) {
        const text = await response.text();
        let reason = text;
        try {
          const parsed = JSON.parse(text) as { message?: string; errors?: Array<{ message?: string }> };
          const detailMessages = parsed.errors?.map((item) => item.message).filter(Boolean).join(' | ');
          reason = [parsed.message, detailMessages].filter(Boolean).join(' | ') || text;
        } catch {
          reason = text;
        }

        await admin
          .from('jobs')
          .update({ status: 'failed', message: `Dispatch failed: ${reason}` })
          .eq('id', jobId);
        return NextResponse.json(
          { error: `Failed to trigger builder workflow: ${reason}` },
          { status: 500, headers: corsHeaders() },
        );
      }
    }

    return NextResponse.json({ success: true, jobId, message: 'Job queued successfully' }, { headers: corsHeaders() });
  } catch (error) {
    console.error('Job creation error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders() });
  }
}
