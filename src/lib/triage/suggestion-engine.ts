import type { TriageActionType, TriageContentType, TriageItem, TriageSourcePlatform, TriageSuggestedAction } from '@/types';

// ─── RULE TYPES ─────────────────────────────────────────────────────────────

export interface TriageRuleMatch {
  contentType?: TriageContentType | TriageContentType[];
  sourcePlatform?: TriageSourcePlatform | TriageSourcePlatform[];
  urlPattern?: string; // regex pattern
  titlePattern?: string; // regex pattern
  categoryContains?: string[];
  subredditIn?: string[];
  haystackContains?: string[]; // match against combined title+description+url
}

export interface TriageRuleSuggestion {
  actionType: TriageActionType;
  confidence: number; // 0-1
  reason: string;
  preFilled?: Record<string, unknown>; // e.g. { tags: ['3d-printing'], list: '3D Printing' }
}

export interface TriageRule {
  id: string;
  name: string;
  priority: number; // lower = evaluated first, higher-priority rules can override
  match: TriageRuleMatch;
  suggest: TriageRuleSuggestion[];
  categories?: string[]; // categories to assign when rule matches
}

export interface SuggestionResult {
  summary: string;
  categories: string[];
  score: number; // 0-100
  urgency: TriageItem['aiUrgency'];
  actions: TriageSuggestedAction[];
  matchedRules: string[]; // rule IDs that matched
}

export interface SuggestionInput {
  sourcePlatform: TriageSourcePlatform;
  contentType: TriageContentType;
  title: string;
  description?: string;
  url: string;
  rawMetadata?: Record<string, unknown>;
}

// ─── ACTION LABELS ──────────────────────────────────────────────────────────

const ACTION_LABELS: Record<TriageActionType, string> = {
  save_karakeep: 'Save to Karakeep',
  save_knowledge_base: 'Save to Knowledge Base',
  create_task_github: 'Create GitHub Task',
  create_task_todo: 'Create Todo Task',
  save_model_catalog: 'Save to Model Catalog',
  trigger_workflow: 'Trigger Workflow',
  complete_action: 'Complete Action',
  open_document: 'Open Document',
  defer_action: 'Defer Action',
  dismiss: 'Dismiss',
  snooze: 'Snooze',
  resurface: 'Resurfaced',
};

// ─── DEFAULT RULES ──────────────────────────────────────────────────────────

export const DEFAULT_RULES: TriageRule[] = [
  // Rule 1: GitHub repos → Karakeep + maybe GitHub task
  {
    id: 'github-repo',
    name: 'GitHub Repository',
    priority: 10,
    match: {
      contentType: 'repo',
      sourcePlatform: 'github',
    },
    suggest: [
      {
        actionType: 'save_karakeep',
        confidence: 0.9,
        reason: 'Repository links are ideal for bookmarking and archiving.',
      },
      {
        actionType: 'create_task_github',
        confidence: 0.3,
        reason: 'May warrant a tracked follow-up if it aligns with active projects.',
      },
    ],
    categories: ['github', 'bookmark'],
  },

  // Rule 2: GitHub repos with homelab/selfhosted keywords
  {
    id: 'github-repo-homelab',
    name: 'GitHub Homelab Repository',
    priority: 5,
    match: {
      contentType: 'repo',
      haystackContains: ['selfhost', 'homelab', 'home-lab'],
    },
    suggest: [
      {
        actionType: 'save_karakeep',
        confidence: 0.9,
        reason: 'Repository relevant to homelab roadmap — archive first.',
        preFilled: { tags: ['homelab'], list: 'Homelab' },
      },
      {
        actionType: 'create_task_todo',
        confidence: 0.7,
        reason: 'Homelab repo likely worth adding to the planning backlog.',
        preFilled: { list: 'Home Automation' },
      },
    ],
    categories: ['github', 'homelab', 'bookmark'],
  },

  // Rule 3: 3D models → Model Catalog
  {
    id: '3d-model',
    name: '3D Model Content',
    priority: 10,
    match: {
      contentType: 'model_3d',
    },
    suggest: [
      {
        actionType: 'save_model_catalog',
        confidence: 0.95,
        reason: 'This is a 3D model that belongs in the model intake flow.',
      },
      {
        actionType: 'save_karakeep',
        confidence: 0.6,
        reason: 'Preserve the source context alongside the model record.',
        preFilled: { tags: ['3d-printing'], list: '3D Printing' },
      },
    ],
    categories: ['3d-printing'],
  },

  // Rule 4: 3D printing marketplace URLs (Thingiverse, Printables, MakerWorld)
  {
    id: '3d-marketplace-url',
    name: '3D Printing Marketplace',
    priority: 8,
    match: {
      urlPattern: '(thingiverse\\.com|printables\\.com|makerworld\\.com)',
    },
    suggest: [
      {
        actionType: 'save_model_catalog',
        confidence: 0.9,
        reason: 'URL is from a 3D model marketplace — belongs in model catalog.',
      },
      {
        actionType: 'save_karakeep',
        confidence: 0.6,
        reason: 'Archive the marketplace listing for reference.',
        preFilled: { tags: ['3d-printing'], list: '3D Printing' },
      },
    ],
    categories: ['3d-printing'],
  },

  // Rule 5: Reddit r/homeassistant, r/selfhosted → Todo + Karakeep
  {
    id: 'reddit-homelab',
    name: 'Reddit Home Automation',
    priority: 10,
    match: {
      sourcePlatform: 'reddit',
      subredditIn: ['homeassistant', 'selfhosted', 'homelab'],
    },
    suggest: [
      {
        actionType: 'create_task_todo',
        confidence: 0.7,
        reason: 'Home automation content worth evaluating for the homelab backlog.',
        preFilled: { list: 'Home Automation' },
      },
      {
        actionType: 'save_karakeep',
        confidence: 0.5,
        reason: 'Keep the source for later review.',
      },
    ],
    categories: ['homelab', 'home-automation'],
  },

  // Rule 6: Reddit r/3Dprinting, r/functionalprint → Model Catalog + Karakeep
  {
    id: 'reddit-3dprinting',
    name: 'Reddit 3D Printing',
    priority: 10,
    match: {
      sourcePlatform: 'reddit',
      subredditIn: ['3Dprinting', 'functionalprint', 'ender3', '3dprinting'],
    },
    suggest: [
      {
        actionType: 'save_model_catalog',
        confidence: 0.8,
        reason: '3D printing subreddit post likely contains model ideas.',
      },
      {
        actionType: 'save_karakeep',
        confidence: 0.6,
        reason: 'Archive the discussion for build notes.',
        preFilled: { tags: ['3d-printing'], list: '3D Printing' },
      },
    ],
    categories: ['3d-printing'],
  },

  // Rule 7: Video content → Karakeep
  {
    id: 'video-content',
    name: 'Video Content',
    priority: 20,
    match: {
      contentType: 'video',
    },
    suggest: [
      {
        actionType: 'save_karakeep',
        confidence: 0.6,
        reason: 'Video content is best archived for later viewing.',
      },
    ],
    categories: ['video'],
  },

  // Rule 8: Homelab/HA keywords in any source
  {
    id: 'homelab-keywords',
    name: 'Homelab Keywords',
    priority: 15,
    match: {
      haystackContains: ['homelab', 'home assistant', 'selfhosted', 'self-hosted'],
    },
    suggest: [
      {
        actionType: 'create_task_todo',
        confidence: 0.7,
        reason: 'Content mentions homelab topics — consider adding to planning backlog.',
        preFilled: { list: 'Home Automation' },
      },
      {
        actionType: 'save_karakeep',
        confidence: 0.6,
        reason: 'Keep as reference material for homelab projects.',
      },
    ],
    categories: ['homelab'],
  },

  // Rule 9: Default fallback → Karakeep
  {
    id: 'default-fallback',
    name: 'Default Capture',
    priority: 100, // lowest priority, always matches
    match: {},
    suggest: [
      {
        actionType: 'save_karakeep',
        confidence: 0.5,
        reason: 'Default capture lane for reference material.',
      },
    ],
    categories: [],
  },
];

// ─── ENGINE ─────────────────────────────────────────────────────────────────

let activeRules: TriageRule[] = [...DEFAULT_RULES];

/** Replace the active rule set. */
export function setRules(rules: TriageRule[]): void {
  activeRules = [...rules];
}

/** Get a copy of the active rules. */
export function getRules(): TriageRule[] {
  return [...activeRules];
}

/** Reset to the default rule set. */
export function resetRules(): void {
  activeRules = [...DEFAULT_RULES];
}

/** Extract subreddit from a Reddit URL or rawMetadata. */
function extractSubreddit(url: string, rawMetadata?: Record<string, unknown>): string | null {
  // Check rawMetadata first (importers often store subreddit)
  if (rawMetadata?.subreddit && typeof rawMetadata.subreddit === 'string') {
    return rawMetadata.subreddit.replace(/^r\//, '');
  }

  const match = url.match(/reddit\.com\/r\/([^/]+)/i);
  return match ? match[1] : null;
}

/** Test whether a rule's match criteria apply to the given input. */
function matchesRule(rule: TriageRule, input: SuggestionInput): boolean {
  const m = rule.match;

  // Empty match = always matches (fallback rules)
  const hasConditions =
    m.contentType !== undefined ||
    m.sourcePlatform !== undefined ||
    m.urlPattern !== undefined ||
    m.titlePattern !== undefined ||
    m.categoryContains !== undefined ||
    m.subredditIn !== undefined ||
    m.haystackContains !== undefined;

  if (!hasConditions) return true;

  // All specified conditions must pass (AND logic)

  if (m.contentType !== undefined) {
    const types = Array.isArray(m.contentType) ? m.contentType : [m.contentType];
    if (!types.includes(input.contentType)) return false;
  }

  if (m.sourcePlatform !== undefined) {
    const platforms = Array.isArray(m.sourcePlatform) ? m.sourcePlatform : [m.sourcePlatform];
    if (!platforms.includes(input.sourcePlatform)) return false;
  }

  if (m.urlPattern !== undefined) {
    try {
      const regex = new RegExp(m.urlPattern, 'i');
      if (!regex.test(input.url)) return false;
    } catch {
      return false;
    }
  }

  if (m.titlePattern !== undefined) {
    try {
      const regex = new RegExp(m.titlePattern, 'i');
      if (!regex.test(input.title)) return false;
    } catch {
      return false;
    }
  }

  if (m.haystackContains !== undefined) {
    const haystack = `${input.title} ${input.description || ''} ${input.url}`.toLowerCase();
    if (!m.haystackContains.some((term) => haystack.includes(term.toLowerCase()))) return false;
  }

  if (m.subredditIn !== undefined) {
    const subreddit = extractSubreddit(input.url, input.rawMetadata);
    if (!subreddit) return false;
    // Case-insensitive subreddit match
    const lower = subreddit.toLowerCase();
    if (!m.subredditIn.some((s) => s.toLowerCase() === lower)) return false;
  }

  return true;
}

/** Determine urgency based on matched rules and content. */
function inferUrgency(input: SuggestionInput, matchedRuleIds: string[]): TriageItem['aiUrgency'] {
  // Repos that are trending / recently starred
  if (input.contentType === 'repo') return 'trending';

  // Time-sensitive: sales, deals, limited
  const haystack = `${input.title} ${input.description || ''}`.toLowerCase();
  if (/(sale|deal|limited|expir|ending soon|discount)/i.test(haystack)) return 'time_sensitive';

  return 'evergreen';
}

/** Build a human-readable summary from matched rules. */
function buildSummary(input: SuggestionInput, matchedRuleIds: string[]): string {
  if (matchedRuleIds.includes('github-repo-homelab')) {
    return 'Repository appears relevant to the homelab roadmap — archive first, then optionally convert into a plan item.';
  }
  if (matchedRuleIds.includes('github-repo')) {
    return 'Repository is a good bookmark candidate and may merit a tracked follow-up if it aligns with active projects.';
  }
  if (matchedRuleIds.includes('3d-model') || matchedRuleIds.includes('3d-marketplace-url')) {
    return 'Capture into the model catalog first, then keep the source for build notes or discussion context.';
  }
  if (matchedRuleIds.includes('reddit-3dprinting')) {
    return '3D printing community post — check for printable models or useful techniques worth capturing.';
  }
  if (matchedRuleIds.includes('reddit-homelab') || matchedRuleIds.includes('homelab-keywords')) {
    return 'Home-lab oriented item; route to a planning task if not acting on it immediately.';
  }
  if (matchedRuleIds.includes('video-content')) {
    return 'Video content — archive for later viewing and reference.';
  }
  return 'General reference item; archive first, then convert to an action only if it survives triage.';
}

/**
 * Evaluate all active rules against a triage item input and return
 * deduplicated, confidence-sorted suggestions.
 */
export function evaluateRules(input: SuggestionInput): SuggestionResult {
  const sortedRules = [...activeRules].sort((a, b) => a.priority - b.priority);

  const matchedRuleIds: string[] = [];
  const categoriesSet = new Set<string>([input.sourcePlatform]);
  const actionMap = new Map<TriageActionType, TriageSuggestedAction>();

  for (const rule of sortedRules) {
    if (!matchesRule(rule, input)) continue;

    matchedRuleIds.push(rule.id);

    // Merge categories
    if (rule.categories) {
      for (const cat of rule.categories) categoriesSet.add(cat);
    }

    // Merge suggestions — keep highest confidence per action type
    for (const s of rule.suggest) {
      const existing = actionMap.get(s.actionType);
      if (!existing || s.confidence > existing.confidence) {
        actionMap.set(s.actionType, {
          actionType: s.actionType,
          confidence: s.confidence,
          reason: s.reason,
          label: ACTION_LABELS[s.actionType] || s.actionType,
        });
      }
    }
  }

  const actions = Array.from(actionMap.values()).sort((a, b) => b.confidence - a.confidence);
  const topConfidence = actions[0]?.confidence ?? 0;
  const score = Math.round(topConfidence * 100);

  return {
    summary: buildSummary(input, matchedRuleIds),
    categories: Array.from(categoriesSet),
    score,
    urgency: inferUrgency(input, matchedRuleIds),
    actions,
    matchedRules: matchedRuleIds,
  };
}
