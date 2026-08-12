import { FinanceInsightRoute } from '@/components/finance/FinanceInsightDetail';

export default async function FinanceInsightPage({
  params,
}: {
  params: Promise<{ occurrenceId: string }>;
}) {
  const { occurrenceId } = await params;
  return <FinanceInsightRoute occurrenceId={occurrenceId} />;
}
