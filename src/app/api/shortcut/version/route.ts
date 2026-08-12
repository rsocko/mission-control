/**
 * GET /api/shortcut/version
 *
 * Returns the latest iOS Shortcut version info for the in-shortcut
 * update checker. No auth required — this is public metadata.
 *
 * To trigger an update prompt for users, bump the version here and
 * update the installUrl if the iCloud link changed.
 */

const SHORTCUT_VERSION = '1.0.0';
const SHORTCUT_INSTALL_URL = process.env.MC_SHORTCUT_INSTALL_URL || 'https://mission-control.example/shortcut/install';
const SHORTCUT_CHANGELOG = 'Initial release — Save to Triage with version checking';

export function GET() {
  return Response.json({
    version: SHORTCUT_VERSION,
    installUrl: SHORTCUT_INSTALL_URL,
    changelog: SHORTCUT_CHANGELOG,
  });
}
