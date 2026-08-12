import { NextResponse } from 'next/server';
import { exchangeCodeForTokens, resolveClientCredentials, storeTokens } from '@/lib/auth';
import { authLogger } from '@/lib/logger';

/**
 * Return an HTML page that posts a message to the opener (parent window)
 * and then closes itself. This is used instead of a redirect so the OAuth
 * popup communicates back to the settings page cleanly.
 */
function popupResponse(payload: { success: boolean; connectorInstanceId?: string; account?: string; error?: string }) {
  const json = JSON.stringify(payload);
  const statusText = payload.success
    ? `Connected as ${payload.account || 'unknown'}. This window will close automatically.`
    : `Error: ${payload.error || 'Unknown error'}`;

  const html = `<!DOCTYPE html>
<html><head><title>OAuth Complete</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee;">
<div style="text-align:center;max-width:400px;">
  <p>${statusText}</p>
  <p style="color:#888;font-size:0.85em;">If this window doesn't close, <a href="/settings" style="color:#60a5fa;">click here</a> to return to settings.</p>
</div>
<script>
  try {
    if (window.opener) {
      window.opener.postMessage({ type: 'mc-oauth-callback', ...${json} }, window.location.origin);
    }
  } catch (e) { console.error('postMessage failed:', e); }
  setTimeout(function() { window.close(); }, 1500);
</script>
</body></html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * GET /api/auth/microsoft/callback — OAuth2 callback from Microsoft
 * Receives the authorization code, exchanges for tokens, stores them.
 * Returns an HTML page that notifies the parent window via postMessage and closes the popup.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const stateB64 = searchParams.get('state');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  if (error) {
    authLogger.error({ oauthError: error, errorDescription }, 'Microsoft OAuth callback returned an error');
    return popupResponse({ success: false, error: errorDescription || error });
  }

  if (!code || !stateB64) {
    authLogger.error('OAuth callback missing authorization code or state');
    return popupResponse({ success: false, error: 'Missing authorization code' });
  }

  try {
    // Decode state
    let state: { connectorInstanceId: string; accountType: 'personal' | 'work'; tenantId: string; clientId?: string };
    try {
      state = JSON.parse(Buffer.from(stateB64, 'base64').toString());
    } catch {
      authLogger.error('Failed to decode OAuth callback state parameter');
      return popupResponse({ success: false, error: 'Invalid state parameter' });
    }

    const { connectorInstanceId, accountType, tenantId, clientId: stateClientId } = state;
    authLogger.info({ connectorInstanceId, accountType, tenantId }, 'Exchanging OAuth code for tokens');

    // Resolve the client secret that matches the clientId used to start the flow.
    // stateClientId was set by the connect route using resolveClientCredentials; we
    // re-resolve here so the token exchange uses the same app registration.
    const { clientId, clientSecret } = stateClientId
      ? (() => {
          const resolved = resolveClientCredentials(accountType);
          // If the state clientId matches what resolveClientCredentials returned, use that
          // secret; otherwise fall through to env-var defaults (handles env rotation).
          return resolved.clientId === stateClientId
            ? resolved
            : { clientId: stateClientId, clientSecret: resolved.clientSecret };
        })()
      : resolveClientCredentials(accountType);

    // Exchange code for tokens
    const tokenSet = await exchangeCodeForTokens({
      code,
      accountType,
      tenantId,
      clientId,
      clientSecret,
      connectorInstanceId,
    });

    // Store tokens in connector config, persisting the clientId for future refreshes
    await storeTokens(connectorInstanceId, tokenSet, clientId);
    authLogger.info({ connectorInstanceId, account: tokenSet.userEmail || connectorInstanceId }, 'Stored OAuth tokens successfully');

    const accountLabel = tokenSet.userEmail || accountType;
    return popupResponse({ success: true, connectorInstanceId, account: accountLabel });
  } catch (err) {
    authLogger.error({ err }, 'OAuth callback failed');
    const message = err instanceof Error ? err.message : String(err);
    return popupResponse({ success: false, error: message });
  }
}
