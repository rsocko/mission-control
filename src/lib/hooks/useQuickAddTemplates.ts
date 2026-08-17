'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { taskLogger } from '@/lib/client-logger';
import type { TaskTemplate } from '@/types';

export function useQuickAddTemplates(input: string) {
  const [isPickerOpen, setPickerOpen] = useState(false);
  const [workflowTemplate, setWorkflowTemplate] = useState<TaskTemplate | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [typeaheadIndex, setTypeaheadIndex] = useState(0);
  const fetchedRef = useRef(false);
  const typeahead = useMemo(() => {
    const match = input.match(/(?:^|\s)t\/(\S*)$/);
    if (!match || templates.length === 0) return null;
    const query = match[1].toLowerCase();
    const matches = query
      ? templates.filter((template) => template.name.toLowerCase().includes(query))
      : templates;
    return matches.length > 0 ? { query, matches } : null;
  }, [input, templates]);

  useEffect(() => {
    if (!input.match(/(?:^|\s)t\/\S*$/)) return;
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetch('/api/subtask-templates')
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load templates (${response.status})`);
        return response.json();
      })
      .then((data) => setTemplates(data.templates || []))
      .catch((error) => {
        fetchedRef.current = false;
        taskLogger.error('Failed to fetch Quick Add templates', { error });
      });
  }, [input, typeahead]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setTypeaheadIndex(0));
    return () => cancelAnimationFrame(frame);
  }, [typeahead?.query]);

  return {
    isPickerOpen,
    setPickerOpen,
    workflowTemplate,
    setWorkflowTemplate,
    selectedTemplateId,
    setSelectedTemplateId,
    typeahead,
    typeaheadIndex,
    setTypeaheadIndex,
  };
}
