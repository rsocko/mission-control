const GITHUB_USER_ATTACHMENT_PATH =
  /^\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGitHubUserAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === ''
      && GITHUB_USER_ATTACHMENT_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

export function getTaskImageSource(src: string, taskId?: string): string {
  if (!taskId || !isGitHubUserAttachmentUrl(src)) return src;

  const query = new URLSearchParams({ url: src });
  return `/api/tasks/${encodeURIComponent(taskId)}/github-attachment?${query}`;
}
