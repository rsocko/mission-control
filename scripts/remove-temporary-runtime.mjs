import { rm } from 'node:fs/promises';

export async function removeTemporaryRuntime(directory, remove = rm) {
  await remove(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
