export class GitHubIssueTransferError extends Error {
  constructor(readonly reason: string) {
    super(`GitHub issue transfer failed: ${reason}`);
    this.name = 'GitHubIssueTransferError';
  }
}
