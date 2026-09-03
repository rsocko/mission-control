import type {
  CopilotLifecycleClient,
  CopilotLifecycleSession,
} from '@/lib/ai/copilot-lifecycle-contracts';
import { runPackagedSyncWorker } from '@/lib/runtime/packaged-sync-worker';

const INTEGRATION_TOKEN = 'postgres-whole-worker';

function requireLoopbackController(): URL {
  if (
    process.env.NODE_ENV !== 'test'
    || process.env.MC_PACKAGED_WORKER_INTEGRATION !== INTEGRATION_TOKEN
    || !process.env.MC_TEST_POSTGRES_URL
    || process.env.MC_TEST_POSTGRES_URL !== process.env.MC_POSTGRES_URL
  ) {
    throw new Error('Packaged worker integration launcher is test-only');
  }
  const url = new URL(process.env.MC_COPILOT_TEST_CONTROLLER_URL ?? '');
  if (
    url.protocol !== 'http:'
    || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
  ) {
    throw new Error('Copilot integration controller must be a loopback HTTP endpoint');
  }
  return url;
}

function createControllerClient(controller: URL): CopilotLifecycleClient {
  const request = async <T>(
    operation: string,
    payload: Record<string, unknown>,
  ): Promise<T> => {
    const response = await fetch(new URL(operation, controller), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Copilot integration controller rejected ${operation}`);
    }
    return await response.json() as T;
  };
  const session = (
    sessionId: string,
    operation: 'create' | 'resume',
  ): CopilotLifecycleSession => ({
    sessionId,
    async sendAndWait(prompt) {
      return {
        data: await request<{ content: string }>('send', {
          operation,
          sessionId,
          promptLength: prompt.length,
        }),
      };
    },
    async abort() {
      await request('abort', { sessionId });
    },
    async disconnect() {
      await request('disconnect', { sessionId });
    },
  });
  return {
    async createSession() {
      const created = await request<{ sessionId: string }>('create', {});
      return session(created.sessionId, 'create');
    },
    async resumeSession(sessionId) {
      await request('resume', { sessionId });
      return session(sessionId, 'resume');
    },
    async deleteSession(sessionId) {
      await request('delete', { sessionId });
    },
  };
}

const controller = requireLoopbackController();
process.env.MC_PROCESS_ROLE = 'worker';

void runPackagedSyncWorker({
  createCopilotClient: () => createControllerClient(controller),
}).catch((error) => {
  console.error('Packaged sync worker integration failed', error);
  process.exit(1);
});
