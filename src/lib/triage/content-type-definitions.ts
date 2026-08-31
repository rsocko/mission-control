import type { TriageContentType } from '@/types';

export interface ContentTypeDefinition {
  id: string;
  name: string;
  icon?: string;
  color: string;
  builtin: boolean;
  suppressed: boolean;
  priority: number;
  urlPatterns: string[];
  keywordHints: string[];
  description?: string;
}

export const BUILTIN_CONTENT_TYPES: readonly ContentTypeDefinition[] = [
  {
    id: 'repo' satisfies TriageContentType,
    name: 'GitHub Repos',
    icon: 'github',
    color: '#24292f',
    builtin: true,
    suppressed: false,
    priority: 10,
    urlPatterns: ['github\\.com/[^/]+/[^/]+'],
    keywordHints: [],
    description: 'GitHub repositories',
  },
  {
    id: 'model_3d' satisfies TriageContentType,
    name: '3D Models',
    icon: 'box',
    color: '#f59e0b',
    builtin: true,
    suppressed: false,
    priority: 15,
    urlPatterns: ['makerworld', 'printables', 'thingiverse'],
    keywordHints: ['3d print', '3d-print', 'functionalprint'],
    description: 'STL files, 3D printing models',
  },
  {
    id: 'video' satisfies TriageContentType,
    name: 'Videos',
    icon: 'play-circle',
    color: '#ef4444',
    builtin: true,
    suppressed: false,
    priority: 20,
    urlPatterns: ['youtube\\.com', 'youtu\\.be', '/reel/', 'instagram\\.com/reel'],
    keywordHints: [],
    description: 'YouTube videos, Instagram Reels, etc.',
  },
  {
    id: 'image' satisfies TriageContentType,
    name: 'Images',
    icon: 'image',
    color: '#ec4899',
    builtin: true,
    suppressed: false,
    priority: 25,
    urlPatterns: ['i\\.redd\\.it/', 'instagram\\.com/p/'],
    keywordHints: [],
    description: 'Instagram posts, Reddit images',
  },
  {
    id: 'text_post' satisfies TriageContentType,
    name: 'Discussions',
    icon: 'message-circle',
    color: '#10b981',
    builtin: true,
    suppressed: false,
    priority: 30,
    urlPatterns: ['(twitter\\.com|x\\.com)/[^/]+/status/'],
    keywordHints: [],
    description: 'Twitter/X posts, forum threads',
  },
  {
    id: 'article' satisfies TriageContentType,
    name: 'Articles',
    icon: 'file-text',
    color: '#6366f1',
    builtin: true,
    suppressed: false,
    priority: 40,
    urlPatterns: [],
    keywordHints: ['article', 'blog'],
    description: 'Blog posts and articles',
  },
  {
    id: 'product' satisfies TriageContentType,
    name: 'Products',
    icon: 'shopping-bag',
    color: '#f97316',
    builtin: true,
    suppressed: false,
    priority: 45,
    urlPatterns: [],
    keywordHints: [],
    description: 'Product pages, things to buy',
  },
  {
    id: 'document' satisfies TriageContentType,
    name: 'Documents',
    icon: 'file-check',
    color: '#3b82f6',
    builtin: true,
    suppressed: false,
    priority: 50,
    urlPatterns: [],
    keywordHints: [],
    description: 'Documents requiring action (bills, letters, forms)',
  },
  {
    id: 'link' satisfies TriageContentType,
    name: 'Links',
    icon: 'link',
    color: '#3b82f6',
    builtin: true,
    suppressed: false,
    priority: 100,
    urlPatterns: [],
    keywordHints: [],
    description: 'Generic links (fallback type)',
  },
];
