export function normalizeAttributionMerchant(value: string | null): string {
  const normalized = (value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || 'Unknown merchant').slice(0, 160);
}
