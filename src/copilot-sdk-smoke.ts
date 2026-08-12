import {
  loadCopilotSmokeConfig,
  runCopilotSmoke,
} from './lib/ai/copilot-runtime-smoke';
import {
  classifyCopilotSmokeError,
  CopilotSmokeError,
} from './lib/ai/copilot-runtime-errors';

const abortController = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => abortController.abort());
}

try {
  if (abortController.signal.aborted) {
    throw new CopilotSmokeError('shutdown_failed', 'shutdown');
  }
  const result = await runCopilotSmoke(
    loadCopilotSmokeConfig(),
    undefined,
    abortController.signal,
  );
  process.stdout.write(`${JSON.stringify({ event: 'copilot_sdk_smoke', ...result })}\n`);
} catch (error) {
  const safeError = classifyCopilotSmokeError(error, 'request');
  process.stderr.write(
    `${JSON.stringify({
      event: 'copilot_sdk_smoke',
      ok: false,
      code: safeError.code,
      phase: safeError.phase,
      message: safeError.message,
    })}\n`,
  );
  process.exitCode = 1;
}
