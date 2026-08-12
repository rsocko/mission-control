type CompletedStep = {
  toolResults: Array<{ toolName: string }>;
};

const READ_ONLY_TOOLS = [
  'getTaskSummary',
  'searchTasks',
  'getTaskTags',
  'getNotifications',
  'suggestDayPlan',
  'getProjects',
  'planPhases',
  'getProjectPhases',
  'searchTriage',
] as const;

/**
 * Triage content can originate outside Mission Control. Do not let it drive a
 * follow-up mutation in the same model run.
 */
export function restrictToolsAfterTriage({ steps }: { steps: CompletedStep[] }) {
  const consumedTriageContent = steps.some(step =>
    step.toolResults.some(result => result.toolName === 'searchTriage')
  );

  return consumedTriageContent ? { activeTools: [...READ_ONLY_TOOLS] } : undefined;
}
