import { FinanceQuickReview } from '@/components/finance/FinanceQuickReview';

export default async function FinanceQuickReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ connectorId?: string | string[] }>;
}) {
  const connectorId = (await searchParams).connectorId;
  return (
    <FinanceQuickReview connectorId={typeof connectorId === 'string' ? connectorId : null} />
  );
}
