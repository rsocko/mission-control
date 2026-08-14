type CompletedStep = {
  toolResults: Array<{ toolName: string }>;
};

const FINANCE_READ_ONLY_TOOLS = [
  'getHouseholdFinanceSummary',
  'searchFinanceTransactions',
  'getPendingFinanceExceptions',
  'getKidSpending',
  'getFinanceObligations',
  'getFinanceConnectorHealth',
] as const;

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
  ...FINANCE_READ_ONLY_TOOLS,
] as const;

/**
 * Triage and finance projections can contain external text. Do not let either
 * drive a follow-up mutation in the same model run.
 */
export function restrictToolsAfterTriage({ steps }: { steps: CompletedStep[] }) {
  const consumedFinanceContent = steps.some(step =>
    step.toolResults.some(result =>
      FINANCE_READ_ONLY_TOOLS.includes(
        result.toolName as typeof FINANCE_READ_ONLY_TOOLS[number],
      )));
  if (consumedFinanceContent) return { activeTools: [...READ_ONLY_TOOLS] };

  const triageStep = steps.findIndex(step =>
    step.toolResults.some(result => result.toolName === 'searchTriage'));
  if (triageStep === -1) return undefined;

  return {
    activeTools: READ_ONLY_TOOLS.filter(tool =>
      !FINANCE_READ_ONLY_TOOLS.includes(
        tool as typeof FINANCE_READ_ONLY_TOOLS[number],
      )),
  };
}
