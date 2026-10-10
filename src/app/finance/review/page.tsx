import { FinanceReview } from '@/components/finance/FinanceReview';

export default async function FinanceReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const filter = parameters.filter === 'receipt-reconciliation'
    ? 'receipt-reconciliation'
    : 'attribution';
  const review = typeof parameters.review === 'string' ? parameters.review : null;
  return <FinanceReview initialFilter={filter} initialReceiptId={review} />;
}
