import 'server-only';
import pino from 'pino';
import { AsyncLocalStorage } from 'async_hooks';

// ─── Request Context (correlation IDs) ──────────────────────────────────────

export interface RequestContext {
  traceId: string;
  method?: string;
  path?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// ─── Logger Configuration ───────────────────────────────────────────────────

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Structured JSON logger for Mission Control.
 *
 * - Production (Docker): JSON lines → Dozzle/Loki auto-parse
 * - Development: pretty-printed with colors via pino-pretty
 */
const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }),
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const ctx = requestContext.getStore();
    if (ctx) {
      return { traceId: ctx.traceId, method: ctx.method, path: ctx.path };
    }
    return {};
  },
});

export default logger;

// ─── Child loggers for subsystems ───────────────────────────────────────────

export const syncLogger = logger.child({ module: 'sync' });
export const dbLogger = logger.child({ module: 'db' });
export const authLogger = logger.child({ module: 'auth' });
export const aiLogger = logger.child({ module: 'ai' });
export const connectorLogger = logger.child({ module: 'connector' });
export const exportLogger = logger.child({ module: 'export' });
