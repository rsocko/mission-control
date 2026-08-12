/**
 * Priority Mapping System
 * 
 * Mission Control uses P0-P3 internally (mapped to existing TaskPriority type):
 *   P0 = critical
 *   P1 = high
 *   P2 = medium
 *   P3 = low
 *   (none) = unset / never prioritized
 * 
 * Each connector defines how its source priority maps to/from these levels.
 * Priority changes sync bidirectionally with conflict logging.
 */

import type { TaskPriority } from '@/types';

// ─── Display Aliases ────────────────────────────────────────────────────────

export const PRIORITY_DISPLAY: Record<TaskPriority, { label: string; pLevel: string; color: string; icon: string }> = {
  critical: { label: 'Critical', pLevel: 'P0', color: '#dc2626', icon: '🔴' },
  high:     { label: 'High',     pLevel: 'P1', color: '#f97316', icon: '🟠' },
  medium:   { label: 'Medium',   pLevel: 'P2', color: '#eab308', icon: '🟡' },
  low:      { label: 'Low',      pLevel: 'P3', color: '#6b7280', icon: '⚪' },
  none:     { label: 'None',     pLevel: '—',  color: '#d1d5db', icon: '' },
};

export const PRIORITY_ORDER: TaskPriority[] = ['critical', 'high', 'medium', 'low', 'none'];

/**
 * Convert P-level string to TaskPriority
 */
export function pLevelToPriority(pLevel: string): TaskPriority {
  switch (pLevel.toUpperCase()) {
    case 'P0': return 'critical';
    case 'P1': return 'high';
    case 'P2': return 'medium';
    case 'P3': return 'low';
    default: return 'none';
  }
}

/**
 * Convert TaskPriority to P-level string
 */
export function priorityToPLevel(priority: TaskPriority): string {
  switch (priority) {
    case 'critical': return 'P0';
    case 'high': return 'P1';
    case 'medium': return 'P2';
    case 'low': return 'P3';
    default: return '—';
  }
}

// ─── Connector Priority Mapping Interface ───────────────────────────────────

/**
 * Defines how a connector maps its source-specific priority values
 * to and from Mission Control's P0–P3 system.
 */
export interface PriorityMapping {
  /** Connector type this mapping applies to */
  connectorType: string;

  /** Whether priority can be written back to this source */
  supportsWriteBack: boolean;

  /** 
   * Map a source-specific priority value to Mission Control priority.
   * Returns null if the source value doesn't map (keep existing).
   */
  mapInbound(sourceValue: unknown): TaskPriority | null;

  /**
   * Map a Mission Control priority to the source-specific value.
   * Returns the value to send to the source API.
   */
  mapOutbound(priority: TaskPriority): unknown;

  /**
   * Determine if a priority change should be written back to the source.
   * Considers the lossy nature of the mapping (e.g., P0 and P1 both map
   * to "starred" in Todo, so changing P0→P1 shouldn't write back).
   */
  shouldWriteBack(oldPriority: TaskPriority, newPriority: TaskPriority): boolean;
}

// ─── Microsoft Todo Priority Mapping ────────────────────────────────────────

/**
 * Microsoft Todo has a binary "importance" flag:
 *   - "high" = starred (⭐)
 *   - "normal" = unstarred
 *   - "low" = exists in API but rarely used in UI
 * 
 * Mapping rules:
 *   Inbound:  starred → P1 (high), unstarred → none (preserve existing if set)
 *   Outbound: P0/P1 → star, P2/P3/none → unstar
 *   Write-back: only when crossing the star/unstar boundary
 */
export const microsoftTodoPriorityMapping: PriorityMapping = {
  connectorType: 'microsoft-todo',
  supportsWriteBack: true,

  mapInbound(sourceValue: unknown): TaskPriority | null {
    const importance = String(sourceValue).toLowerCase();
    switch (importance) {
      case 'high': return 'high';       // starred → P1
      case 'low': return 'low';         // API low → P3
      case 'normal': return null;       // unstarred → don't override (keep existing or 'none')
      default: return null;
    }
  },

  mapOutbound(priority: TaskPriority): string {
    // P0/P1 → star it, everything else → unstar
    switch (priority) {
      case 'critical':
      case 'high':
        return 'high';    // Graph API importance value for "starred"
      default:
        return 'normal';  // Graph API importance value for "unstarred"
    }
  },

  shouldWriteBack(oldPriority: TaskPriority, newPriority: TaskPriority): boolean {
    // Only write back when crossing the star/unstar boundary
    const wasStarred = oldPriority === 'critical' || oldPriority === 'high';
    const shouldBeStarred = newPriority === 'critical' || newPriority === 'high';
    return wasStarred !== shouldBeStarred;
  },
};

// ─── GitHub Issues Priority Mapping ─────────────────────────────────────────

/**
 * GitHub Projects has customizable priority fields (typically P0–P3).
 * GitHub Issues can use labels like "priority: critical", "priority: high".
 * 
 * Mapping rules:
 *   Inbound:  Match label patterns or project field values
 *   Outbound: Apply/remove priority labels
 *   Write-back: When priority level changes
 */
export const githubPriorityMapping: PriorityMapping = {
  connectorType: 'github-issues',
  supportsWriteBack: true,

  mapInbound(sourceValue: unknown): TaskPriority | null {
    if (!sourceValue) return null;
    const val = String(sourceValue).toLowerCase();

    // Match GitHub Projects priority field values
    if (val === 'p0' || val === 'urgent' || val === 'critical') return 'critical';
    if (val === 'p1' || val === 'high') return 'high';
    if (val === 'p2' || val === 'medium' || val === 'default') return 'medium';
    if (val === 'p3' || val === 'low') return 'low';

    // Match label patterns like "priority: high", "priority/P1"
    if (val.includes('critical') || val.includes('p0') || val.includes('urgent')) return 'critical';
    if (val.includes('high') || val.includes('p1')) return 'high';
    if (val.includes('medium') || val.includes('p2')) return 'medium';
    if (val.includes('low') || val.includes('p3')) return 'low';

    return null;
  },

  mapOutbound(priority: TaskPriority): string | null {
    switch (priority) {
      case 'critical': return 'priority: critical';
      case 'high': return 'priority: high';
      case 'medium': return 'priority: medium';
      case 'low': return 'priority: low';
      default: return null; // Remove priority label
    }
  },

  shouldWriteBack(oldPriority: TaskPriority, newPriority: TaskPriority): boolean {
    // Write back any time the priority level actually changes
    return oldPriority !== newPriority;
  },
};

// ─── Default (No-Op) Mapping for Sources Without Priority ───────────────────

export const nullPriorityMapping: PriorityMapping = {
  connectorType: '*',
  supportsWriteBack: false,

  mapInbound(): TaskPriority | null {
    return null; // No priority concept in source
  },

  mapOutbound(): unknown {
    return null;
  },

  shouldWriteBack(): boolean {
    return false; // Never write back
  },
};

// ─── Registry ───────────────────────────────────────────────────────────────

const mappings = new Map<string, PriorityMapping>([
  ['microsoft-todo', microsoftTodoPriorityMapping],
  ['github-issues', githubPriorityMapping],
]);

/**
 * Get the priority mapping for a given connector type.
 * Falls back to nullPriorityMapping for unknown types.
 */
export function getPriorityMapping(connectorType: string): PriorityMapping {
  return mappings.get(connectorType) || nullPriorityMapping;
}

/**
 * Register a custom priority mapping (for user-configured connectors)
 */
export function registerPriorityMapping(connectorType: string, mapping: PriorityMapping): void {
  mappings.set(connectorType, mapping);
}

// ─── Sync Conflict Detection ────────────────────────────────────────────────

export interface PrioritySyncEvent {
  taskId: string;
  connectorType: string;
  connectorInstanceId: string;
  previousPriority: TaskPriority;
  newPriority: TaskPriority;
  source: 'inbound' | 'outbound';
  writeBackTriggered: boolean;
  timestamp: string;
  note?: string;
}

/**
 * Determine inbound priority, respecting the mapping rules.
 * 
 * Rules:
 * - If source says "starred" (high) → set P1, unless already P0 (don't downgrade)
 * - If source says "unstarred" (null mapping) → downgrade to P2 if was P0/P1
 * - If task has never been prioritized → accept source value
 */
export function resolveInboundPriority(
  currentPriority: TaskPriority,
  sourceValue: unknown,
  connectorType: string,
): { priority: TaskPriority; changed: boolean; event?: Partial<PrioritySyncEvent> } {
  const mapping = getPriorityMapping(connectorType);
  const mappedPriority = mapping.mapInbound(sourceValue);

  // Source has no priority concept or value is unmappable
  if (mappedPriority === null) {
    // Special case: if source explicitly says "unstarred/normal" and we were starred
    // Check if this is MS Todo specifically returning "normal" (unstarred)
    if (connectorType === 'microsoft-todo' && String(sourceValue).toLowerCase() === 'normal') {
      const wasStarred = currentPriority === 'critical' || currentPriority === 'high';
      if (wasStarred) {
        // User unstarred in Todo → downgrade to P2
        return {
          priority: 'medium',
          changed: true,
          event: {
            previousPriority: currentPriority,
            newPriority: 'medium',
            source: 'inbound',
            note: `Unstarred in Microsoft Todo — downgraded from ${priorityToPLevel(currentPriority)} to P2`,
          },
        };
      }
    }
    return { priority: currentPriority, changed: false };
  }

  // Source says it's high priority (starred)
  if (mappedPriority === 'high' || mappedPriority === 'critical') {
    // Don't downgrade: if already P0, keep P0
    if (currentPriority === 'critical' && mappedPriority === 'high') {
      return { priority: currentPriority, changed: false };
    }
  }

  // Accept the mapped priority if it differs
  if (currentPriority !== mappedPriority) {
    return {
      priority: mappedPriority,
      changed: true,
      event: {
        previousPriority: currentPriority,
        newPriority: mappedPriority,
        source: 'inbound',
        note: `Source priority "${sourceValue}" mapped to ${priorityToPLevel(mappedPriority)}`,
      },
    };
  }

  return { priority: currentPriority, changed: false };
}

/**
 * Determine if an outbound priority write-back should happen and what value to send.
 */
export function resolveOutboundPriority(
  oldPriority: TaskPriority,
  newPriority: TaskPriority,
  connectorType: string,
): { shouldWrite: boolean; sourceValue: unknown; event?: Partial<PrioritySyncEvent> } {
  const mapping = getPriorityMapping(connectorType);

  if (!mapping.supportsWriteBack) {
    return { shouldWrite: false, sourceValue: null };
  }

  const shouldWrite = mapping.shouldWriteBack(oldPriority, newPriority);
  const sourceValue = mapping.mapOutbound(newPriority);

  if (shouldWrite) {
    return {
      shouldWrite: true,
      sourceValue,
      event: {
        previousPriority: oldPriority,
        newPriority,
        source: 'outbound',
        writeBackTriggered: true,
        note: `Priority changed ${priorityToPLevel(oldPriority)} → ${priorityToPLevel(newPriority)}, writing "${sourceValue}" to source`,
      },
    };
  }

  return { shouldWrite: false, sourceValue: null };
}
