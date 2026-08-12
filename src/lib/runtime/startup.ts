export function terminateFailedStartup(error: unknown): never {
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
  throw error;
}
