import 'server-only';

import logger from '@/lib/logger';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1_000;
const MIN_INTERVAL_MS = 30_000;

function intervalMs(): number {
  const configured = Number(process.env.MC_PAPERCLIP_APPROVAL_POLL_MS);
  return Number.isSafeInteger(configured) && configured >= MIN_INTERVAL_MS
    ? configured
    : DEFAULT_INTERVAL_MS;
}

export class PaperclipApprovalScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeRun: Promise<void> | null = null;
  private stopping = false;

  async start(): Promise<void> {
    if (this.timer) return;
    this.stopping = false;
    await this.run();
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => void this.run(), intervalMs());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.activeRun;
  }

  private run(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.activeRun) return this.activeRun;
    const run = (async () => {
      try {
        const { reconcilePaperclipApprovals } = await import('./paperclip-approvals');
        const result = await reconcilePaperclipApprovals();
        if (result.failures.length > 0) {
          logger.warn({
            module: 'paperclip-approvals',
            agents: result.agents,
            failures: result.failures.length,
            deferred: result.deferred,
          }, 'Paperclip approval polling completed with failures');
        }
      } catch (error) {
        logger.error(
          { err: error, module: 'paperclip-approvals' },
          'Paperclip approval polling failed',
        );
      }
    })();
    const active = run.finally(() => {
      if (this.activeRun === active) this.activeRun = null;
    });
    this.activeRun = active;
    return active;
  }
}

export const paperclipApprovalScheduler = new PaperclipApprovalScheduler();
