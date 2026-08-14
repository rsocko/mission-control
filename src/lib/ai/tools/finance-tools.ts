import { tool, zodSchema } from 'ai';
import {
  getFinanceConnectorHealth,
  getFinanceObligations,
  getHouseholdFinanceSummary,
  getKidSpending,
  getPendingFinanceExceptions,
  HoustonFinanceToolError,
  searchFinanceTransactions,
} from '@/lib/finance/houston-tools';
import {
  financeConnectorHealthInputSchema,
  financeConnectorHealthOutputSchema,
  financeObligationsInputSchema,
  financeObligationsOutputSchema,
  financeTransactionSearchInputSchema,
  financeTransactionSearchOutputSchema,
  householdFinanceSummaryInputSchema,
  householdFinanceSummaryOutputSchema,
  kidSpendingInputSchema,
  kidSpendingOutputSchema,
  pendingFinanceExceptionsInputSchema,
  pendingFinanceExceptionsOutputSchema,
} from '@/lib/finance/houston-contracts';

const FINANCE_TOOL_TIMEOUT_MS = 3_000;

async function executeFinanceTool<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, FINANCE_TOOL_TIMEOUT_MS);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : timeoutController.signal;
  try {
    return await operation(signal);
  } catch (error) {
    if (timedOut) {
      throw new Error('[finance_timeout] The finance request timed out.');
    }
    if (error instanceof HoustonFinanceToolError) {
      throw new Error(`[${error.code}] ${error.message}`);
    }
    throw new Error('[finance_unavailable] Finance data is temporarily unavailable.');
  } finally {
    clearTimeout(timeout);
  }
}

export const financeTools = {
  getHouseholdFinanceSummary: tool({
    description: 'Get a bounded household spending summary from Mission Control persisted finance data.',
    inputSchema: zodSchema(householdFinanceSummaryInputSchema),
    outputSchema: zodSchema(householdFinanceSummaryOutputSchema),
    execute: (input, options) => executeFinanceTool(
      signal => getHouseholdFinanceSummary(input, { signal }),
      options.abortSignal,
    ),
  }),
  searchFinanceTransactions: tool({
    description: 'Search bounded persisted finance transactions by date, merchant, category, household member, or triage status.',
    inputSchema: zodSchema(financeTransactionSearchInputSchema),
    outputSchema: zodSchema(financeTransactionSearchOutputSchema),
    execute: (input, options) => executeFinanceTool(
      signal => searchFinanceTransactions(input, { signal }),
      options.abortSignal,
    ),
  }),
  getPendingFinanceExceptions: tool({
    description: 'List bounded pending Tyrion attribution exceptions without exposing raw identifiers.',
    inputSchema: zodSchema(pendingFinanceExceptionsInputSchema),
    outputSchema: zodSchema(pendingFinanceExceptionsOutputSchema),
    execute: (input, options) => executeFinanceTool(
      signal => getPendingFinanceExceptions(input, { signal }),
      options.abortSignal,
    ),
  }),
  getKidSpending: tool({
    description: 'Get bounded spending and recent transaction context for one household member by name.',
    inputSchema: zodSchema(kidSpendingInputSchema),
    outputSchema: zodSchema(kidSpendingOutputSchema),
    execute: (input, options) => executeFinanceTool(
      signal => getKidSpending(input, { signal }),
      options.abortSignal,
    ),
  }),
  getFinanceObligations: tool({
    description: 'Get bounded recurring obligations from the persisted Tyrion Bridge projection.',
    inputSchema: zodSchema(financeObligationsInputSchema),
    outputSchema: zodSchema(financeObligationsOutputSchema),
    execute: (input, options) => executeFinanceTool(
      signal => getFinanceObligations(input, { signal }),
      options.abortSignal,
    ),
  }),
  getFinanceConnectorHealth: tool({
    description: 'Get sanitized freshness and health for the persisted finance projection and Tyrion attribution.',
    inputSchema: zodSchema(financeConnectorHealthInputSchema),
    outputSchema: zodSchema(financeConnectorHealthOutputSchema),
    execute: (input, options) => executeFinanceTool(
      signal => getFinanceConnectorHealth(input, { signal }),
      options.abortSignal,
    ),
  }),
};
