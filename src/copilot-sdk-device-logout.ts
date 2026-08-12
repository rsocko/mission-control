import { logoutCopilotDevice } from './lib/ai/copilot-device-logout';

try {
  const result = await logoutCopilotDevice('/state', '/work');
  process.stdout.write(
    `${JSON.stringify({ event: 'copilot_device_logout', ...result })}\n`,
  );
} catch {
  process.stderr.write(
    `${JSON.stringify({
      event: 'copilot_device_logout',
      ok: false,
      message: 'The stored device credential could not be logged out safely.',
    })}\n`,
  );
  process.exitCode = 1;
}
