import type { TriageContentType } from '@/types';
import { BUILTIN_CONTENT_TYPES } from './content-type-definitions';

export function detectBuiltInContentType(
  url: string,
  title: string,
  description?: string,
): TriageContentType {
  const combined = `${title} ${description || ''} ${url}`.toLowerCase();
  for (const contentType of BUILTIN_CONTENT_TYPES) {
    if (contentType.id === 'link') continue;
    const matchesUrl = contentType.urlPatterns.some((pattern) => (
      new RegExp(pattern, 'i').test(url)
    ));
    const matchesKeyword = contentType.keywordHints.some((hint) => (
      combined.includes(hint.toLowerCase())
    ));
    if (matchesUrl || matchesKeyword) return contentType.id as TriageContentType;
  }
  return 'link';
}
