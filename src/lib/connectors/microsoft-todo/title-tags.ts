function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function removeMicrosoftTodoTitleTag(title: string, tagName: string): string {
  const hashtagSlug = tagName.replace(/\s+/g, '-');
  return title
    .replace(new RegExp(`\\s*#${escapeRegExp(hashtagSlug)}(?![\\w-])`, 'gi'), '')
    .trim()
    .replace(/\s{2,}/g, ' ');
}
