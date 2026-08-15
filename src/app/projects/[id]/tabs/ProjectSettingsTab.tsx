'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import {
  CheckCircle2,
  Link2,
  List,
  LoaderCircle,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  Tag,
  TriangleAlert,
  Type,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { IconPickerButton } from '@/components/ui/icon-picker';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { COLOR_PRESETS } from '@/lib/constants/colors';
import { fadeSlideUp } from '@/lib/motion';
import { resolveProjectIconColor } from '@/lib/projects/normalize-project';
import { fetchAllTasks } from '@/lib/tasks/fetch-all';
import { cn } from '@/lib/utils';
import type { AutoIncludeRule, ProjectStatus } from '@/types';
import { STATUS_LABELS } from '../constants';
import {
  useProjectPageData,
  useProjectPageMutations,
} from '../context';
import { ProjectActionsCard } from '../ProjectActionsCard';
import type { ProjectRuleMatch, ProjectTask } from '../types';
import { formatRelativeTime, getProjectStatus } from '../utils';
import type { RequestConfirmation } from './contracts';

interface ProjectSettingsTabProps {
  /** True while this tab is the visible Activity boundary. */
  active: boolean;
  /** List-selection capability per connector instance, fetched by the shell. */
  connectorListModes: Record<string, string>;
  /** Opens the shared confirmation dialog owned by the shell. */
  requestConfirmation: RequestConfirmation;
}

export function ProjectSettingsTab({
  active,
  connectorListModes,
  requestConfirmation,
}: ProjectSettingsTabProps) {
  const { project, projectId } = useProjectPageData();
  const { setProject, setTasks } = useProjectPageMutations();
  const router = useRouter();
  const currentProjectIdRef = useRef(projectId);
  currentProjectIdRef.current = projectId;

  const [ruleMatches, setRuleMatches] = useState<ProjectRuleMatch[]>([]);
  const [ruleMatchesLoading, setRuleMatchesLoading] = useState(false);
  const [savingRules, setSavingRules] = useState(false);
  const [existingCategories, setExistingCategories] = useState<string[]>([]);
  const [categorySaved, setCategorySaved] = useState(false);

  const loadProjectTasks = useCallback(async () => {
    return fetchAllTasks<ProjectTask>(`/api/tasks?projectId=${projectId}&parentOnly=true&sortBy=updated`);
  }, [projectId]);

  const loadRuleMatches = useCallback(async () => {
    setRuleMatchesLoading(true);
    try {
      const response = await fetch(`/api/hub-projects/${projectId}/rule-matches`);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || 'Failed to load qualifying tasks');
      }
      const payload = (await response.json()) as { matches?: ProjectRuleMatch[] };
      if (projectId === currentProjectIdRef.current) {
        setRuleMatches(payload.matches ?? []);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load qualifying tasks');
    } finally {
      if (projectId === currentProjectIdRef.current) setRuleMatchesLoading(false);
    }
  }, [projectId]);

  const updateAutoIncludeRules = useCallback(async (
    updated: AutoIncludeRule[],
    successMessage?: string,
  ) => {
    setSavingRules(true);
    try {
      const response = await fetch(`/api/hub-projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoIncludeRules: updated }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        evaluation?: { added: number };
        evaluationFailed?: boolean;
      } | null;
      if (!response.ok) throw new Error(payload?.error || 'Failed to update rules');

      setProject((previous) => previous ? { ...previous, autoIncludeRules: updated } : previous);
      const [currentTasks] = await Promise.all([loadProjectTasks(), loadRuleMatches()]);
      if (projectId === currentProjectIdRef.current) setTasks(currentTasks);
      if (payload?.evaluationFailed) {
        toast.warning('Rule saved, but matching tasks could not be added. Try refreshing the preview.');
      } else if (successMessage) {
        const added = payload?.evaluation?.added ?? 0;
        toast.success(added > 0 ? `${successMessage} · ${added} task${added === 1 ? '' : 's'} added` : successMessage);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update rules');
      throw error;
    } finally {
      if (projectId === currentProjectIdRef.current) setSavingRules(false);
    }
  }, [loadProjectTasks, loadRuleMatches, projectId, setProject, setTasks]);

  const restoreAutoIncludedTask = useCallback(async (taskId: string) => {
    setSavingRules(true);
    try {
      const response = await fetch(`/api/hub-projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || 'Failed to restore task');

      const [currentTasks] = await Promise.all([loadProjectTasks(), loadRuleMatches()]);
      if (projectId === currentProjectIdRef.current) setTasks(currentTasks);
      toast.success('Task restored to auto-include');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to restore task');
    } finally {
      if (projectId === currentProjectIdRef.current) setSavingRules(false);
    }
  }, [loadProjectTasks, loadRuleMatches, projectId, setTasks]);

  // Activity tears these effects down while Settings is hidden, so the preview
  // and category options only load for a visible Settings tab.
  useEffect(() => {
    void loadRuleMatches();
  }, [loadRuleMatches]);

  useEffect(() => {
    fetch('/api/projects-overview')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.categories) return;
        const cats = (data.categories as { category: string }[]).map(c => c.category).filter(Boolean);
        setExistingCategories(cats);
      })
      .catch(() => {});
  }, []);

  const handleHideProject = useCallback(() => {
    if (!project) return;
    requestConfirmation({
      title: 'Hide project?',
      message: `Hide "${project.name}"? It will be removed from project navigation and portfolio views. You can unhide it from All Projects.`,
      confirmLabel: 'Hide project',
      variant: 'warning',
      onConfirm: async (close) => {
        try {
          const res = await fetch(`/api/hub-projects/${projectId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hidden: true }),
          });
          if (!res.ok) throw new Error('Failed to hide project');
          toast.success('Project hidden');
          window.dispatchEvent(new Event('projects-updated'));
          router.push('/projects');
        } catch {
          toast.error('Failed to hide project');
        } finally {
          close();
        }
      },
    });
  }, [project, projectId, requestConfirmation, router]);

  const handleDeleteProject = useCallback(() => {
    if (!project) return;
    requestConfirmation({
      title: 'Delete project',
      message: `Are you sure you want to delete "${project.name}"? This cannot be undone. Tasks assigned to this project will not be deleted.`,
      confirmLabel: 'Delete project',
      variant: 'danger',
      onConfirm: async (close) => {
        try {
          const res = await fetch(`/api/hub-projects/${projectId}`, { method: 'DELETE' });
          if (!res.ok) throw new Error('Failed to delete project');
          toast.success('Project deleted');
          window.dispatchEvent(new Event('projects-updated'));
          router.push('/projects');
        } catch {
          toast.error('Failed to delete project');
        } finally {
          close();
        }
      },
    });
  }, [project, projectId, requestConfirmation, router]);

  // The Activity boundary keeps the rule preview state warm; only the active
  // tab contributes markup.
  if (!active || !project) return null;

  const excludedRuleMatches = ruleMatches.filter((match) => match.excluded);
  const activeRuleMatches = ruleMatches.filter((match) => !match.excluded);

  return (
    <motion.section variants={fadeSlideUp} className="space-y-6">
      {/* General */}
      <Card className="border-[var(--border-subtle)]">
        <CardHeader>
          <CardTitle className="text-base">General</CardTitle>
          <CardDescription>Project name, description, icon, and color.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">Name</label>
            <div>
              <input
                key={`name-${project.name}`}
                type="text"
                className={cn(
                  "flex h-9 rounded-[var(--radius-md)] px-3 py-2 text-sm bg-[var(--surface-0)] text-[var(--text-primary)] border border-[var(--border)] transition-[border-color,box-shadow] duration-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-0)] w-full max-w-md",
                  project.metadata?.syncManaged ? 'opacity-60 cursor-not-allowed' : 'hover:border-[var(--border-strong)]',
                )}
                defaultValue={project.name}
                disabled={!!project.metadata?.syncManaged}
                onBlur={async (e) => {
                  const val = e.target.value.trim();
                  if (!val || val === project.name) return;
                  try {
                    const res = await fetch(`/api/hub-projects/${projectId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name: val }),
                    });
                    if (!res.ok) throw new Error('Failed to update name');
                    setProject((prev) => prev ? { ...prev, name: val } : prev);
                    toast.success('Name updated');
                    window.dispatchEvent(new Event('projects-updated'));
                  } catch {
                    toast.error('Failed to update name');
                  }
                }}
              />
              {!!project.metadata?.syncManaged && (
                <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">Managed by GitHub sync</p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">Description</label>
            <div>
              <textarea
                key={`desc-${project.description ?? ''}`}
                className={cn(
                  "flex min-h-[80px] resize-y rounded-[var(--radius-md)] px-3 py-2 text-sm bg-[var(--surface-0)] text-[var(--text-primary)] border border-[var(--border)] transition-[border-color,box-shadow] duration-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-0)] w-full max-w-md",
                  project.metadata?.syncManaged ? 'opacity-60 cursor-not-allowed' : 'hover:border-[var(--border-strong)]',
                )}
                placeholder="What is this project about?"
                defaultValue={project.description || ''}
                disabled={!!project.metadata?.syncManaged}
                onBlur={async (e) => {
                  const val = e.target.value.trim() || null;
                  if (val === (project.description || null)) return;
                  try {
                    const res = await fetch(`/api/hub-projects/${projectId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ description: val }),
                    });
                    if (!res.ok) throw new Error('Failed to update description');
                    setProject((prev) => prev ? { ...prev, description: val } : prev);
                    toast.success('Description updated');
                  } catch {
                    toast.error('Failed to update description');
                  }
                }}
              />
              {!!project.metadata?.syncManaged && (
                <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">Managed by GitHub sync</p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">Icon</label>
            <IconPickerButton
              value={project.icon || null}
              onChange={async (val) => {
                const icon = val.trim() || null;
                if (icon === (project.icon || null)) return;
                try {
                  const res = await fetch(`/api/hub-projects/${projectId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      icon,
                      iconColor: resolveProjectIconColor(project.iconColor, project.color),
                    }),
                  });
                  if (!res.ok) throw new Error('Failed to update icon');
                  setProject((prev) => prev ? { ...prev, icon } : prev);
                  toast.success('Icon updated');
                  window.dispatchEvent(new Event('projects-updated'));
                } catch {
                  toast.error('Failed to update icon');
                }
              }}
              size="md"
              color={resolveProjectIconColor(project.iconColor, project.color)}
              onColorChange={async (iconColor) => {
                try {
                  // Sync icon color → project color when the chosen color exists in presets
                  const matchingPreset = COLOR_PRESETS.find((p) => p === iconColor);
                  const patchBody: Record<string, string> = { iconColor };
                  if (matchingPreset) patchBody.color = matchingPreset;
                  const res = await fetch(`/api/hub-projects/${projectId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(patchBody),
                  });
                  if (!res.ok) throw new Error('Failed to update icon color');
                  setProject((prev) => prev ? { ...prev, iconColor, ...(matchingPreset ? { color: matchingPreset } : {}) } : prev);
                  if (matchingPreset) window.dispatchEvent(new Event('projects-updated'));
                } catch {
                  toast.error('Failed to update icon color');
                }
              }}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">
              <span className="inline-flex items-center gap-1"><Palette size={13} /> Color</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {COLOR_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={async () => {
                    if (preset === project.color) return;
                    try {
                      // Sync project color → icon color
                      const patchBody: Record<string, string> = { color: preset, iconColor: preset };
                      const res = await fetch(`/api/hub-projects/${projectId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(patchBody),
                      });
                      if (!res.ok) throw new Error('Failed to update color');
                      setProject((prev) => prev ? { ...prev, color: preset, iconColor: preset } : prev);
                      toast.success('Color updated');
                      window.dispatchEvent(new Event('projects-updated'));
                    } catch {
                      toast.error('Failed to update color');
                    }
                  }}
                  className={`flex h-8 w-8 items-center justify-center rounded-full border transition-transform hover:scale-110 ${
                    project.color === preset ? 'border-white/90' : 'border-white/20'
                  }`}
                  style={{
                    backgroundColor: preset,
                    boxShadow: project.color === preset ? `0 0 0 2px ${preset}55` : undefined,
                  }}
                  aria-label={`Select ${preset} color`}
                >
                  {project.color === preset && <span className="h-2 w-2 rounded-full bg-white/90" />}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Auto-Include Rules */}
      <Card className="border-[var(--border-subtle)]">
        <CardHeader>
          <CardTitle className="text-base">Auto-Include Rules</CardTitle>
          <CardDescription>Automatically add tasks matching these rules to this project.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(project.autoIncludeRules as AutoIncludeRule[]).map((rule, index) => (
            <div key={index} className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--surface-0)] text-[var(--text-muted)]">
                {rule.type === 'tag' && <Tag size={14} />}
                {rule.type === 'title_contains' && <Type size={14} />}
                {rule.type === 'source_list' && <List size={14} />}
                {rule.type === 'connector' && <Plug size={14} />}
              </div>
              <Select
                value={rule.type}
                disabled={savingRules}
                onValueChange={async (value) => {
                  const updated = [...(project.autoIncludeRules as AutoIncludeRule[])];
                  updated[index] = { ...rule, type: value as AutoIncludeRule['type'] };
                  try {
                    await updateAutoIncludeRules(updated, 'Rule updated');
                  } catch { /* handled by updateAutoIncludeRules */ }
                }}
              >
                <SelectTrigger
                  className="h-9 min-h-0 w-[160px] shrink-0"
                  aria-label={`Rule ${index + 1} type`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tag">Label / Tag</SelectItem>
                  <SelectItem value="title_contains">Title contains</SelectItem>
                  <SelectItem value="source_list">Source list</SelectItem>
                  <SelectItem value="connector">Connector</SelectItem>
                </SelectContent>
              </Select>
              <input
                type="text"
                defaultValue={rule.value}
                key={`rule-${index}-${rule.type}`}
                placeholder={
                  rule.type === 'tag' ? 'e.g. di-mc-integration' :
                  rule.type === 'title_contains' ? 'e.g. [Phase 0]' :
                  rule.type === 'source_list' ? 'e.g. octo-org/ideation' :
                  'Connector instance ID'
                }
                className="flex h-9 rounded-[var(--radius-md)] px-3 py-2 text-sm bg-[var(--surface-0)] text-[var(--text-primary)] border border-[var(--border)] flex-1"
                disabled={savingRules}
                onBlur={async (e) => {
                  const val = e.target.value;
                  if (val === rule.value) return;
                  const updated = [...(project.autoIncludeRules as AutoIncludeRule[])];
                  updated[index] = { ...rule, value: val };
                  try {
                    await updateAutoIncludeRules(updated, 'Rule updated');
                  } catch { /* handled by updateAutoIncludeRules */ }
                }}
              />
              <button
                type="button"
                disabled={savingRules}
                onClick={async () => {
                  const updated = (project.autoIncludeRules as AutoIncludeRule[]).filter((_, i) => i !== index);
                  try {
                    await updateAutoIncludeRules(updated, 'Rule removed');
                  } catch { /* handled by updateAutoIncludeRules */ }
                }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-red-500/10 hover:text-red-400"
                aria-label="Remove rule"
              >
                <X size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              const updated = [...(project.autoIncludeRules as AutoIncludeRule[]), { type: 'tag' as const, value: '' }];
              setProject((prev) => prev ? { ...prev, autoIncludeRules: updated } : prev);
            }}
            disabled={savingRules}
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            <Plus size={12} />
            Add Rule
          </button>
          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  Qualifying tasks{ruleMatches.length > 0 ? ` (${ruleMatches.length})` : ''}
                </p>
                <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                  A task qualifies when it matches any rule. Tag names ignore a leading # and letter case.
                </p>
                <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                  Rules add matching tasks; removing a rule does not unlink tasks already in the project.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {ruleMatches.some((match) => !match.alreadyAssigned && !match.excluded) ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={savingRules}
                    onClick={() => void updateAutoIncludeRules(
                      project.autoIncludeRules as AutoIncludeRule[],
                      'Matching tasks added',
                    )}
                  >
                    Retry include
                  </Button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void loadRuleMatches()}
                  disabled={ruleMatchesLoading}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)] disabled:opacity-50"
                  aria-label="Refresh qualifying tasks"
                >
                  <RefreshCw size={14} className={ruleMatchesLoading ? 'animate-spin' : ''} />
                </button>
              </div>
            </div>
            {ruleMatchesLoading ? (
              <div className="mt-3 flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                <LoaderCircle size={13} className="animate-spin" />
                Checking tasks…
              </div>
            ) : ruleMatches.length === 0 ? (
              <p className="mt-3 text-xs text-[var(--text-tertiary)]">
                No tasks currently match these rules.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {excludedRuleMatches.length > 0 ? (
                  <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                    <div className="mb-2">
                      <p className="text-sm font-medium text-[var(--text-primary)]">
                        Excluded from auto-include ({excludedRuleMatches.length})
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                        These tasks still match, but manual removal prevents rules and syncs from adding them back.
                      </p>
                    </div>
                    <div className="space-y-2">
                      {excludedRuleMatches.map((match) => (
                        <div key={match.taskId} className="flex items-start justify-between gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-[var(--text-primary)]">{match.title}</p>
                            <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                              {match.reasons.join(' · ')}
                              {match.excludedAt ? ` · Excluded ${formatRelativeTime(match.excludedAt)}` : ''}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={savingRules}
                            onClick={() => void restoreAutoIncludedTask(match.taskId)}
                          >
                            Restore
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {activeRuleMatches.slice(0, 10).map((match) => (
                  <div key={match.taskId} className="flex items-start justify-between gap-3 rounded-md border border-[var(--border-subtle)] px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-[var(--text-primary)]">{match.title}</p>
                      <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{match.reasons.join(' · ')}</p>
                    </div>
                    <Badge variant="outline" className="shrink-0">
                      {match.alreadyAssigned ? 'Included' : 'Not added'}
                    </Badge>
                  </div>
                ))}
                {activeRuleMatches.length > 10 ? (
                  <p className="text-xs text-[var(--text-tertiary)]">
                    And {activeRuleMatches.length - 10} more in the All Tasks tab.
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Status */}
      <Card className="border-[var(--border-subtle)]">
        <CardHeader>
          <CardTitle className="text-base">Project Status</CardTitle>
          <CardDescription>Control the lifecycle status of this project.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">Status</label>
            <Select
              value={getProjectStatus(project)}
              onValueChange={async (value: string) => {
                try {
                  const res = await fetch(`/api/hub-projects/${projectId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ statusOverride: value }),
                  });
                  if (!res.ok) throw new Error('Failed to update status');
                  setProject((prev) => prev ? { ...prev, statusOverride: value as ProjectStatus } : prev);
                  toast.success(`Status updated to ${STATUS_LABELS[value as ProjectStatus]}`);
                } catch {
                  toast.error('Failed to update project status');
                }
              }}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">Category</label>
            <div className="relative">
              <input
                key={`category-${project.category ?? ''}`}
                type="text"
                list="project-category-options"
                className="flex h-9 rounded-[var(--radius-md)] px-3 py-2 text-sm bg-[var(--surface-0)] text-[var(--text-primary)] border border-[var(--border)] transition-[border-color,box-shadow] duration-75 hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-0)] w-48"
                placeholder="e.g. Personal, Work"
                defaultValue={project.category || ''}
                onBlur={async (e) => {
                  const val = e.target.value.trim() || null;
                  if (val === (project.category || null)) return;
                  try {
                    const res = await fetch(`/api/hub-projects/${projectId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ category: val }),
                    });
                    if (!res.ok) throw new Error('Failed to update category');
                    setProject((prev) => prev ? { ...prev, category: val } : prev);
                    setCategorySaved(true);
                    setTimeout(() => setCategorySaved(false), 2000);
                    window.dispatchEvent(new Event('projects-updated'));
                  } catch {
                    toast.error('Failed to update category');
                  }
                }}
              />
              {categorySaved && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-green-400">
                  <CheckCircle2 size={14} />
                </span>
              )}
              <datalist id="project-category-options">
                {existingCategories.map((cat) => (
                  <option key={cat} value={cat} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">Target date</label>
            <input
              key={`target-date-${project.targetDate ?? ''}`}
              type="date"
              className="flex h-9 rounded-[var(--radius-md)] px-3 py-2 text-sm bg-[var(--surface-0)] text-[var(--text-primary)] border border-[var(--border)] transition-[border-color,box-shadow] duration-75 hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-0)] w-48"
              defaultValue={project.targetDate ? project.targetDate.split('T')[0] : ''}
              onBlur={async (e) => {
                const val = e.target.value || null;
                if (val === (project.targetDate ? project.targetDate.split('T')[0] : null)) return;
                try {
                  const res = await fetch(`/api/hub-projects/${projectId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetDate: val }),
                  });
                  if (!res.ok) throw new Error('Failed to update target date');
                  setProject((prev) => prev ? { ...prev, targetDate: val } : prev);
                  toast.success('Target date updated');
                } catch {
                  toast.error('Failed to update target date');
                }
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Source Bindings */}
      <Card className="border-[var(--border-subtle)]">
        <CardHeader>
          <CardTitle className="text-base">Source bindings</CardTitle>
          <CardDescription>Connected inputs that feed the project automatically.</CardDescription>
        </CardHeader>
        <CardContent>
          {Array.isArray(project.sourceBindings) && project.sourceBindings.length ? (
            <div className="space-y-3">
              {project.sourceBindings.map((binding, index) => {
                const listMode = connectorListModes[binding.connectorInstanceId];
                const needsListWarning = !binding.sourceListId && listMode === 'required';
                return (
                <div key={`${binding.connectorInstanceId}-${binding.sourceListId ?? index}`} className={`rounded-[var(--radius-lg)] border bg-[var(--surface-0)] p-4 ${needsListWarning ? 'border-amber-400/60' : 'border-[var(--border)]'}`}>
                  <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                    <Link2 size={14} className="text-[var(--text-tertiary)]" />
                    {binding.connectorInstanceId}
                  </div>
                  {needsListWarning && (
                    <div className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                      <TriangleAlert size={13} className="mt-0.5 flex-shrink-0" />
                      <span>No default list set — new tasks will go to the first configured list. Consider picking a specific target list.</span>
                    </div>
                  )}
                  <div className="mt-2 grid gap-1 text-xs text-[var(--text-secondary)]">
                    <p>Source list: {binding.sourceListId || 'All lists'}</p>
                    {binding.defaultSourceListId && (
                      <p>Default write target: {binding.defaultSourceListId}</p>
                    )}
                    <p>Filter: {binding.filter || 'No additional filter'}</p>
                  </div>
                </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-0)] p-4 text-sm text-[var(--text-tertiary)]">
              No source bindings configured for this project.
            </div>
          )}
        </CardContent>
      </Card>

      <ProjectActionsCard
        syncManaged={Boolean(project.metadata?.syncManaged)}
        onHide={handleHideProject}
        onDelete={handleDeleteProject}
      />
    </motion.section>
  );
}
