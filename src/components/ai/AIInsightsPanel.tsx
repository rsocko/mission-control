'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useListAnimate } from '@/lib/hooks/useListAnimate';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, BarChart3, Bell, Brain, Calendar, Sparkles, Tags, Trash2, Users, Zap } from 'lucide-react';
import { toast } from 'sonner';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  canEditTaskField,
  selectedTaskFieldBlockedReason,
  taskFieldBlockedReason,
} from '@/lib/tasks/client-edit-policy';
import type { TaskEditPolicy } from '@/types';

type InsightTab = 'digest' | 'priority' | 'tags' | 'notifications' | 'next' | 'projects';
type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
type NotificationRecommendation = 'act_now' | 'schedule' | 'dismiss' | 'delegate';
type EnergyLevel = 'high' | 'med' | 'low';

interface DailyDigestResponse {
  digest: string;
  generatedAt: string;
}

interface SmartPriorityResponse {
  rankings: Array<{ taskId: string; title: string; score: number; reason: string; editPolicy: TaskEditPolicy }>;
}

interface InferTagsResponse {
  suggestions: Array<{ taskId: string; title: string; suggestedTags: string[]; confidence: number; editPolicy: TaskEditPolicy }>;
}

interface NotificationTriageResponse {
  actions: Array<{ notificationId: string; title: string; recommendation: NotificationRecommendation; reason: string }>;
}

interface WhatsNextResponse {
  recommendation: string;
  generatedAt: string;
}

interface AssignProjectsResponse {
  assignments: Array<{ taskId: string; title: string; projectId: string; projectName: string; confidence: number; editPolicy: TaskEditPolicy }>;
}

const insightTabs: Array<{ id: InsightTab; label: string; icon: typeof Brain }> = [
  { id: 'digest', label: 'Daily Digest', icon: Brain },
  { id: 'priority', label: 'Smart Priority', icon: BarChart3 },
  { id: 'tags', label: 'Tag Suggestions', icon: Tags },
  { id: 'notifications', label: 'Notification Triage', icon: Bell },
  { id: 'next', label: "What's Next", icon: Zap },
  { id: 'projects', label: 'Assign Projects', icon: Sparkles },
];

const actionButtonClassName = 'px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const cardClassName = 'bg-[var(--surface-1)] border border-[var(--border)] rounded-lg p-4';

export function AIInsightsPanel() {
  const [activeTab, setActiveTab] = useState<InsightTab>('digest');
  const [notificationListRef] = useListAnimate();

  const [digest, setDigest] = useState<DailyDigestResponse | null>(null);
  const [digestLoading, setDigestLoading] = useState(false);

  const [priorityRankings, setPriorityRankings] = useState<SmartPriorityResponse['rankings']>([]);
  const [priorityLoading, setPriorityLoading] = useState(false);
  const [priorityApplying, setPriorityApplying] = useState<string[]>([]);

  const [tagSuggestions, setTagSuggestions] = useState<InferTagsResponse['suggestions']>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagApplying, setTagApplying] = useState<string[]>([]);

  const [triageActions, setTriageActions] = useState<NotificationTriageResponse['actions']>([]);
  const [triageLoading, setTriageLoading] = useState(false);
  const [triageApplying, setTriageApplying] = useState<NotificationRecommendation[]>([]);

  const [timeAvailable, setTimeAvailable] = useState('30');
  const [energy, setEnergy] = useState<EnergyLevel>('med');
  const [focusArea, setFocusArea] = useState('');
  const [whatsNext, setWhatsNext] = useState<WhatsNextResponse | null>(null);
  const [whatsNextLoading, setWhatsNextLoading] = useState(false);

  const [projectAssignments, setProjectAssignments] = useState<AssignProjectsResponse['assignments']>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectApplying, setProjectApplying] = useState<string[]>([]);

  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; title: string; message: string; confirmLabel: string; variant: 'danger' | 'warning'; onConfirm: () => void }>({ open: false, title: '', message: '', confirmLabel: '', variant: 'warning', onConfirm: () => {} });

  const requestConfirm = useCallback((title: string, message: string, confirmLabel: string, variant: 'danger' | 'warning', onConfirm: () => void) => {
    setConfirmDialog({ open: true, title, message, confirmLabel, variant, onConfirm });
  }, []);

  const groupedNotifications = useMemo(() => {
    return {
      act_now: triageActions.filter(action => action.recommendation === 'act_now'),
      schedule: triageActions.filter(action => action.recommendation === 'schedule'),
      dismiss: triageActions.filter(action => action.recommendation === 'dismiss'),
      delegate: triageActions.filter(action => action.recommendation === 'delegate'),
    };
  }, [triageActions]);
  const allTagsBlockedReason = selectedTaskFieldBlockedReason(
    tagSuggestions.map((suggestion) => suggestion.editPolicy),
    'tags',
  );
  const allProjectsBlockedReason = selectedTaskFieldBlockedReason(
    projectAssignments.map((assignment) => assignment.editPolicy),
    'projects',
  );

  async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
    const response = await fetch(input, init);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'Request failed');
    }

    return data as T;
  }

  async function generateDigest() {
    try {
      setDigestLoading(true);
      const result = await fetchJson<DailyDigestResponse>('/api/ai/daily-digest');
      setDigest(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to generate digest');
    } finally {
      setDigestLoading(false);
    }
  }

  async function analyzePriorities() {
    try {
      setPriorityLoading(true);
      const result = await fetchJson<SmartPriorityResponse>('/api/ai/smart-priority');
      setPriorityRankings(result.rankings || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to analyze priorities');
    } finally {
      setPriorityLoading(false);
    }
  }

  async function inferTags() {
    try {
      setTagsLoading(true);
      const result = await fetchJson<InferTagsResponse>('/api/ai/infer-tags');
      setTagSuggestions(result.suggestions || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to infer tags');
    } finally {
      setTagsLoading(false);
    }
  }

  async function triageNotifications() {
    try {
      setTriageLoading(true);
      const result = await fetchJson<NotificationTriageResponse>('/api/ai/triage-alerts');
      setTriageActions(result.actions || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to triage notifications');
    } finally {
      setTriageLoading(false);
    }
  }

  async function getWhatsNext() {
    try {
      setWhatsNextLoading(true);
      const params = new URLSearchParams({
        timeAvailable,
        energy,
      });

      if (focusArea.trim()) {
        params.set('focus', focusArea.trim());
      }

      const result = await fetchJson<WhatsNextResponse>(`/api/ai/whats-next?${params.toString()}`);
      setWhatsNext(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to get recommendation');
    } finally {
      setWhatsNextLoading(false);
    }
  }

  async function assignProjects() {
    try {
      setProjectsLoading(true);
      const result = await fetchJson<AssignProjectsResponse>('/api/ai/assign-projects', { method: 'POST' });
      setProjectAssignments(result.assignments || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to suggest project assignments');
    } finally {
      setProjectsLoading(false);
    }
  }

  async function applyPriority(taskId: string, score: number) {
    const ranking = priorityRankings.find((candidate) => candidate.taskId === taskId);
    if (!canEditTaskField(ranking?.editPolicy, 'priority')) {
      toast.error(taskFieldBlockedReason(ranking?.editPolicy, 'priority'));
      return;
    }
    const priority = scoreToPriority(score);

    try {
      setPriorityApplying(current => [...current, taskId]);
      await fetchJson(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority }),
      });
      toast.success(`Priority updated to ${priority}`);
      setPriorityRankings(current => current.filter(ranking => ranking.taskId !== taskId));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update task priority');
    } finally {
      setPriorityApplying(current => current.filter(id => id !== taskId));
    }
  }

  async function applyTagsToTask(taskId: string, suggestedTags: string[]) {
    const suggestion = tagSuggestions.find((candidate) => candidate.taskId === taskId);
    if (!canEditTaskField(suggestion?.editPolicy, 'tags')) {
      toast.error(taskFieldBlockedReason(suggestion?.editPolicy, 'tags'));
      return;
    }
    try {
      setTagApplying(current => [...current, taskId]);
      await fetchJson(`/api/tasks/${taskId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: suggestedTags }),
      });
      toast.success('Tags applied');
      setTagSuggestions(current => current.filter(suggestion => suggestion.taskId !== taskId));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to apply tags');
    } finally {
      setTagApplying(current => current.filter(id => id !== taskId));
    }
  }

  async function applyAllTags() {
    const suggestions = [...tagSuggestions];
    if (!suggestions.length) return;
    if (allTagsBlockedReason) {
      toast.error(allTagsBlockedReason);
      return;
    }

    try {
      setTagApplying(suggestions.map(suggestion => suggestion.taskId));
      await Promise.all(suggestions.map(suggestion => fetchJson(`/api/tasks/${suggestion.taskId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: suggestion.suggestedTags }),
      })));
      toast.success('All tags applied');
      setTagSuggestions([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to apply all tags');
    } finally {
      setTagApplying([]);
    }
  }

  async function applyTriageGroup(recommendation: NotificationRecommendation) {
    const group = groupedNotifications[recommendation];
    if (!group.length) return;

    try {
      setTriageApplying(current => [...current, recommendation]);
      const action = recommendation === 'dismiss' ? 'dismiss' : 'mark_read';
      await fetchJson('/api/notifications/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: group.map(action => action.notificationId),
          action,
        }),
      });
      toast.success(`${formatRecommendation(recommendation)} applied`);
      setTriageActions(current => current.filter(action => action.recommendation !== recommendation));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to apply notification action');
    } finally {
      setTriageApplying(current => current.filter(value => value !== recommendation));
    }
  }

  async function applyProjectAssignment(taskId: string, projectId: string) {
    const assignment = projectAssignments.find((candidate) => candidate.taskId === taskId);
    if (!canEditTaskField(assignment?.editPolicy, 'projects')) {
      toast.error(taskFieldBlockedReason(assignment?.editPolicy, 'projects'));
      return;
    }
    try {
      setProjectApplying(current => [...current, taskId]);
      await fetchJson(`/api/hub-projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      toast.success('Project assignment applied');
      setProjectAssignments(current => current.filter(assignment => assignment.taskId !== taskId));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to assign project');
    } finally {
      setProjectApplying(current => current.filter(id => id !== taskId));
    }
  }

  async function applyAllProjectAssignments() {
    const assignments = [...projectAssignments];
    if (!assignments.length) return;
    if (allProjectsBlockedReason) {
      toast.error(allProjectsBlockedReason);
      return;
    }

    try {
      setProjectApplying(assignments.map(assignment => assignment.taskId));
      await Promise.all(assignments.map(assignment => fetchJson(`/api/hub-projects/${assignment.projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: assignment.taskId }),
      })));
      toast.success('All project assignments applied');
      setProjectAssignments([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to apply all project assignments');
    } finally {
      setProjectApplying([]);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--border)] px-6 pt-4">
        <div className="flex flex-wrap gap-4">
          {insightTabs.map(tab => {
            const Icon = tab.icon;

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 border-b-2 px-1 pb-3 text-sm transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-[var(--text-primary)]'
                    : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Icon size={16} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 12, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -12, filter: 'blur(2px)' }}
            transition={{ duration: 0.2 }}
            className="space-y-4"
          >
            {activeTab === 'digest' && (
              <>
                <div className={`${cardClassName} flex items-center justify-between gap-4`}>
                  <div>
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">Daily Digest</h2>
                    <p className="text-sm text-[var(--text-secondary)]">Generate a quick markdown briefing for today.</p>
                  </div>
                  <button type="button" onClick={generateDigest} disabled={digestLoading} className={actionButtonClassName}>
                    {digestLoading ? 'Generating…' : 'Generate Digest'}
                  </button>
                </div>

                {digest && (
                  <div className={cardClassName}>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="text-sm font-medium text-[var(--text-primary)]">Latest digest</h3>
                      <span className="text-xs text-[var(--text-muted)]">{formatTimestamp(digest.generatedAt)}</span>
                    </div>
                    <div className="rounded-lg bg-[var(--surface-0)] p-4 text-sm text-[var(--text-secondary)]">
                      <SimpleMarkdown content={digest.digest} />
                    </div>
                  </div>
                )}
              </>
            )}

            {activeTab === 'priority' && (
              <>
                <div className={`${cardClassName} flex items-center justify-between gap-4`}>
                  <div>
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">Smart Priority</h2>
                    <p className="text-sm text-[var(--text-secondary)]">Analyze urgency scores and apply suggested priorities.</p>
                  </div>
                  <button type="button" onClick={analyzePriorities} disabled={priorityLoading} className={actionButtonClassName}>
                    {priorityLoading ? 'Analyzing…' : 'Analyze Priorities'}
                  </button>
                </div>

                {priorityRankings.map(ranking => (
                  <div key={ranking.taskId} className={cardClassName}>
                    <div className="mb-3 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-[var(--text-primary)]">{ranking.title}</p>
                        <p className="mt-1 text-sm text-[var(--text-secondary)]">{ranking.reason}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => requestConfirm('Apply priority', `Set priority to "${scoreToPriority(ranking.score)}" for "${ranking.title}"?`, 'Apply', 'warning', () => applyPriority(ranking.taskId, ranking.score))}
                        disabled={priorityApplying.includes(ranking.taskId) || !canEditTaskField(ranking.editPolicy, 'priority')}
                        title={!canEditTaskField(ranking.editPolicy, 'priority') ? taskFieldBlockedReason(ranking.editPolicy, 'priority') : undefined}
                        className={actionButtonClassName}
                      >
                        {priorityApplying.includes(ranking.taskId) ? 'Applying…' : 'Apply'}
                      </button>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
                        <span>Score</span>
                        <span>{ranking.score}/100</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-[var(--surface-2)]">
                        <div
                          className={`h-1.5 rounded-full bg-gradient-to-r ${getScoreGradient(ranking.score)}`}
                          style={{ width: `${Math.max(8, ranking.score)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}

                {!priorityLoading && !priorityRankings.length && (
                  <EmptyState message="Ready to rank your priorities — hit Run to get started." />
                )}
              </>
            )}

            {activeTab === 'tags' && (
              <>
                <div className={`${cardClassName} flex items-center justify-between gap-4`}>
                  <div>
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">Tag Suggestions</h2>
                    <p className="text-sm text-[var(--text-secondary)]">Infer tags for untagged tasks and apply them in one click.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => requestConfirm('Apply all tags', `Apply AI-suggested tags to ${tagSuggestions.length} task${tagSuggestions.length === 1 ? '' : 's'}? This will add new tags to each task.`, 'Apply All', 'warning', applyAllTags)} disabled={!tagSuggestions.length || tagApplying.length > 0 || Boolean(allTagsBlockedReason)} title={allTagsBlockedReason} className={actionButtonClassName}>
                      Apply All
                    </button>
                    <button type="button" onClick={inferTags} disabled={tagsLoading} className={actionButtonClassName}>
                      {tagsLoading ? 'Inferring…' : 'Infer Tags'}
                    </button>
                  </div>
                </div>

                {tagSuggestions.map(suggestion => (
                  <div key={suggestion.taskId} className={cardClassName}>
                    <div className="mb-3 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-[var(--text-primary)]">{suggestion.title}</p>
                        <p className="mt-1 text-xs text-[var(--text-muted)]">
                          Confidence: <span className={getConfidenceClassName(suggestion.confidence)}>{getConfidenceLabel(suggestion.confidence)}</span>
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => requestConfirm('Apply tags', `Add tags [${suggestion.suggestedTags.join(', ')}] to "${suggestion.title}"?`, 'Apply', 'warning', () => applyTagsToTask(suggestion.taskId, suggestion.suggestedTags))}
                        disabled={tagApplying.includes(suggestion.taskId) || !canEditTaskField(suggestion.editPolicy, 'tags')}
                        title={!canEditTaskField(suggestion.editPolicy, 'tags') ? taskFieldBlockedReason(suggestion.editPolicy, 'tags') : undefined}
                        className={actionButtonClassName}
                      >
                        {tagApplying.includes(suggestion.taskId) ? 'Applying…' : 'Apply'}
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {suggestion.suggestedTags.map(tag => (
                        <span key={`${suggestion.taskId}-${tag}`} className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}

                {!tagsLoading && !tagSuggestions.length && (
                  <EmptyState message="Tags help you find things fast — run inference to auto-suggest them." />
                )}
              </>
            )}

            {activeTab === 'notifications' && (
              <>
                <div className={`${cardClassName} flex items-center justify-between gap-4`}>
                  <div>
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">Notification Triage</h2>
                    <p className="text-sm text-[var(--text-secondary)]">Group unread notifications into immediate, scheduled, delegated, or dismissible actions.</p>
                  </div>
                  <button type="button" onClick={triageNotifications} disabled={triageLoading} className={actionButtonClassName}>
                    {triageLoading ? 'Triaging…' : 'Triage Notifications'}
                  </button>
                </div>

                {([
                  ['act_now', 'Act Now', 'border-red-500/40 bg-red-500/10'],
                  ['schedule', 'Schedule', 'border-blue-500/40 bg-blue-500/10'],
                  ['dismiss', 'Dismiss', 'border-gray-500/40 bg-gray-500/10'],
                  ['delegate', 'Delegate', 'border-purple-500/40 bg-purple-500/10'],
                ] as const).map(([recommendation, label, accentClass]) => {
                  const items = groupedNotifications[recommendation];

                  if (!items.length) {
                    return null;
                  }

                  const showApply = recommendation !== 'act_now';

                  const recommendationIcons: Record<string, React.ReactNode> = {
                    act_now: <AlertCircle className="h-4 w-4 text-red-500" />,
                    schedule: <Calendar className="h-4 w-4 text-blue-500" />,
                    dismiss: <Trash2 className="h-4 w-4 text-gray-500" />,
                    delegate: <Users className="h-4 w-4 text-purple-500" />,
                  };

                  return (
                    <div key={recommendation} className={`${cardClassName} ${accentClass}`}>
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          {recommendationIcons[recommendation]}
                          <div>
                            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{label}</h3>
                          <p className="text-xs text-[var(--text-secondary)]">{items.length} notification{items.length === 1 ? '' : 's'}</p>
                        </div>
                        </div>
                        {showApply && (
                          <button
                            type="button"
                            onClick={() => requestConfirm(`${formatRecommendation(recommendation)} notifications`, `Apply "${formatRecommendation(recommendation)}" to ${items.length} notification${items.length === 1 ? '' : 's'}? This will update their status.`, 'Apply', recommendation === 'dismiss' ? 'danger' : 'warning', () => applyTriageGroup(recommendation))}
                            disabled={triageApplying.includes(recommendation)}
                            className={actionButtonClassName}
                          >
                            {triageApplying.includes(recommendation) ? 'Applying…' : 'Apply'}
                          </button>
                        )}
                      </div>

                      <div ref={notificationListRef} className="space-y-3">
                        {items.map(item => (
                          <div key={item.notificationId} className="rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-3">
                            <p className="text-sm font-medium text-[var(--text-primary)]">{item.title}</p>
                            <p className="mt-1 text-sm text-[var(--text-secondary)]">{item.reason}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}

                {!triageLoading && !triageActions.length && (
                  <EmptyState message="Triage sorts your notifications into actions — run it to clear the noise." />
                )}
              </>
            )}

            {activeTab === 'next' && (
              <>
                <div className={cardClassName}>
                  <div className="mb-4">
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">What&apos;s Next</h2>
                    <p className="text-sm text-[var(--text-secondary)]">Ask for a recommendation based on time, energy, and focus.</p>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <label className="space-y-1">
                      <span className="text-xs text-[var(--text-muted)]">Time available</span>
                      <Select value={timeAvailable} onValueChange={(v) => setTimeAvailable(v)}>
                        <SelectTrigger className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="15">15 min</SelectItem>
                          <SelectItem value="30">30 min</SelectItem>
                          <SelectItem value="60">60 min</SelectItem>
                          <SelectItem value="120">120 min</SelectItem>
                        </SelectContent>
                      </Select>
                    </label>

                    <label className="space-y-1">
                      <span className="text-xs text-[var(--text-muted)]">Energy</span>
                      <Select value={energy} onValueChange={(v) => setEnergy(v as EnergyLevel)}>
                        <SelectTrigger className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="high">High</SelectItem>
                          <SelectItem value="med">Medium</SelectItem>
                          <SelectItem value="low">Low</SelectItem>
                        </SelectContent>
                      </Select>
                    </label>

                    <label className="space-y-1">
                      <span className="text-xs text-[var(--text-muted)]">Focus area</span>
                      <input value={focusArea} onChange={event => setFocusArea(event.target.value)} placeholder="Deep work, email, bugs..." className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none" />
                    </label>
                  </div>

                  <div className="mt-4">
                    <button type="button" onClick={getWhatsNext} disabled={whatsNextLoading} className={actionButtonClassName}>
                      {whatsNextLoading ? 'Thinking…' : 'Get Recommendation'}
                    </button>
                  </div>
                </div>

                {whatsNext && (
                  <div className={cardClassName}>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="text-sm font-medium text-[var(--text-primary)]">Recommendation</h3>
                      <span className="text-xs text-[var(--text-muted)]">{formatTimestamp(whatsNext.generatedAt)}</span>
                    </div>
                    <div className="rounded-lg bg-[var(--surface-0)] p-4 text-sm text-[var(--text-secondary)] whitespace-pre-wrap">
                      {whatsNext.recommendation}
                    </div>
                  </div>
                )}
              </>
            )}

            {activeTab === 'projects' && (
              <>
                <div className={`${cardClassName} flex items-center justify-between gap-4`}>
                  <div>
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">Assign Projects</h2>
                    <p className="text-sm text-[var(--text-secondary)]">Match open tasks to the most relevant projects.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => requestConfirm('Apply all project assignments', `Assign ${projectAssignments.length} task${projectAssignments.length === 1 ? '' : 's'} to their suggested projects? This will update task-project relationships.`, 'Apply All', 'warning', applyAllProjectAssignments)} disabled={!projectAssignments.length || projectApplying.length > 0 || Boolean(allProjectsBlockedReason)} title={allProjectsBlockedReason} className={actionButtonClassName}>
                      Apply All
                    </button>
                    <button type="button" onClick={assignProjects} disabled={projectsLoading} className={actionButtonClassName}>
                      {projectsLoading ? 'Matching…' : 'Assign Projects'}
                    </button>
                  </div>
                </div>

                {projectAssignments.map(assignment => (
                  <div key={assignment.taskId} className={cardClassName}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-[var(--text-primary)]">{assignment.title}</p>
                        <p className="mt-1 text-sm text-[var(--text-secondary)]">
                          Suggested project: <span className="font-medium text-[var(--text-primary)]">{assignment.projectName}</span>
                        </p>
                        <p className="mt-1 text-xs text-[var(--text-muted)]">Confidence {Math.round(assignment.confidence * 100)}%</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => requestConfirm('Assign project', `Assign "${assignment.title}" to project "${assignment.projectName}"?`, 'Apply', 'warning', () => applyProjectAssignment(assignment.taskId, assignment.projectId))}
                        disabled={projectApplying.includes(assignment.taskId) || !canEditTaskField(assignment.editPolicy, 'projects')}
                        title={!canEditTaskField(assignment.editPolicy, 'projects') ? taskFieldBlockedReason(assignment.editPolicy, 'projects') : undefined}
                        className={actionButtonClassName}
                      >
                        {projectApplying.includes(assignment.taskId) ? 'Applying…' : 'Apply'}
                      </button>
                    </div>
                  </div>
                ))}

                {!projectsLoading && !projectAssignments.length && (
                  <EmptyState message="Match tasks to projects so nothing floats — run the matcher to start." />
                )}
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        confirmVariant={confirmDialog.variant}
        onConfirm={() => { setConfirmDialog(d => ({ ...d, open: false })); confirmDialog.onConfirm(); }}
        onCancel={() => setConfirmDialog(d => ({ ...d, open: false }))}
      />
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className={`${cardClassName} text-sm text-[var(--text-secondary)]`}>
      {message}
    </div>
  );
}

function SimpleMarkdown({ content }: { content: string }) {
  const lines = content.split('\n');
  const blocks: ReactNode[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (!line) {
      continue;
    }

    if (line.startsWith('## ')) {
      blocks.push(
        <h2 key={`h2-${index}`} className="mt-4 text-base font-semibold text-[var(--text-primary)] first:mt-0">
          {renderInlineMarkdown(line.slice(3))}
        </h2>
      );
      continue;
    }

    if (line.startsWith('# ')) {
      blocks.push(
        <h1 key={`h1-${index}`} className="mt-4 text-lg font-semibold text-[var(--text-primary)] first:mt-0">
          {renderInlineMarkdown(line.slice(2))}
        </h1>
      );
      continue;
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      const items: string[] = [];

      while (index < lines.length) {
        const listLine = lines[index].trim();
        if (!(listLine.startsWith('- ') || listLine.startsWith('* '))) {
          index -= 1;
          break;
        }
        items.push(listLine.slice(2));
        index += 1;
      }

      blocks.push(
        <ul key={`list-${index}`} className="list-disc space-y-1 pl-5 text-sm text-[var(--text-secondary)]">
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    blocks.push(
      <p key={`p-${index}`} className="text-sm leading-6 text-[var(--text-secondary)]">
        {renderInlineMarkdown(line)}
      </p>
    );
  }

  return <div className="space-y-3">{blocks}</div>;
}

function renderInlineMarkdown(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${part}-${index}`} className="font-semibold text-[var(--text-primary)]">{part.slice(2, -2)}</strong>;
    }

    return <span key={`${part}-${index}`}>{part}</span>;
  });
}

function scoreToPriority(score: number): TaskPriority {
  if (score > 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function getScoreGradient(score: number) {
  if (score > 80) return 'from-red-500 to-rose-400';
  if (score >= 60) return 'from-orange-500 to-amber-400';
  if (score >= 40) return 'from-yellow-500 to-amber-300';
  return 'from-emerald-500 to-lime-400';
}

function getConfidenceLabel(confidence: number) {
  if (confidence >= 0.75) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

function getConfidenceClassName(confidence: number) {
  if (confidence >= 0.75) return 'text-emerald-400';
  if (confidence >= 0.5) return 'text-amber-400';
  return 'text-rose-400';
}

function formatRecommendation(recommendation: NotificationRecommendation) {
  if (recommendation === 'act_now') return 'Act now';
  if (recommendation === 'schedule') return 'Schedule';
  if (recommendation === 'dismiss') return 'Dismiss';
  return 'Delegate';
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}
