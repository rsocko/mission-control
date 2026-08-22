export function buildPaperlessPreviewUrl(
  documentUrl: string | undefined,
  documentId: string | number,
): string | undefined {
  if (!documentUrl) return undefined;

  try {
    const url = new URL(documentUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

    const documentsPathIndex = url.pathname.indexOf('/documents/');
    const basePath = documentsPathIndex >= 0
      ? url.pathname.slice(0, documentsPathIndex)
      : '';
    url.pathname = `${basePath}/api/documents/${documentId}/preview/`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}
