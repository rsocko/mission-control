/**
 * Client-side structured logger for Mission Control.
 *
 * Mirrors the pino child-logger pattern used on the server (`src/lib/logger.ts`)
 * so that client components log with consistent context (module + operation).
 *
 * In development the output goes to the browser console; a future iteration can
 * POST errors to an `/api/log` endpoint for server-side aggregation.
 */

interface LogContext {
  module: string;
  [key: string]: unknown;
}

interface ClientLogger {
  error(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  debug(msg: string, extra?: Record<string, unknown>): void;
  child(ctx: Record<string, unknown>): ClientLogger;
}

function createLogger(context: LogContext): ClientLogger {
  const fmt = (msg: string, extra?: Record<string, unknown>) => ({
    ...context,
    ...extra,
    msg,
    time: new Date().toISOString(),
  });

  return {
    error(msg, extra) {
      console.error('[error]', fmt(msg, extra));
    },
    warn(msg, extra) {
      console.warn('[warn]', fmt(msg, extra));
    },
    info(msg, extra) {
      console.info('[info]', fmt(msg, extra));
    },
    debug(msg, extra) {
      console.debug('[debug]', fmt(msg, extra));
    },
    child(ctx) {
      return createLogger({ ...context, ...ctx });
    },
  };
}

// ─── Pre-built child loggers (mirrors server logger.ts) ─────────────────────

const clientLogger = createLogger({ module: 'app' });

export default clientLogger;

export const uiLogger = createLogger({ module: 'ui' });
export const taskLogger = createLogger({ module: 'task' });
export const settingsLogger = createLogger({ module: 'settings' });
export const projectLogger = createLogger({ module: 'project' });
export const kanbanLogger = createLogger({ module: 'kanban' });
