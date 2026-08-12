export class ExternalAgentError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ExternalAgentError';
  }
}

export function isExternalAgentError(error: unknown): error is ExternalAgentError {
  return error instanceof ExternalAgentError;
}
