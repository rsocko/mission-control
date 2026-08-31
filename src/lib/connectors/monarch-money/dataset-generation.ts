import type {
  FinanceReferenceDataset,
  FinanceReferenceDatasetItem,
} from '@/db/persistence/finance-datasets';
import {
  canonicalizeFinanceInsightV1,
  financeInsightDigestV1,
  type CanonicalJsonValue,
} from '@/lib/finance-insights/canonical';

function projectionValue(
  dataset: FinanceReferenceDataset,
  item: FinanceReferenceDatasetItem,
): CanonicalJsonValue {
  if (dataset === 'accounts') {
    if (!('displayName' in item)) throw new Error('Invalid account projection item');
    return {
      id: item.id,
      displayName: item.displayName,
      type: item.type,
      institution: item.institution,
      mask: item.mask,
      isActive: item.isActive,
    };
  }
  if (dataset === 'categories') {
    if (!('groupId' in item)) throw new Error('Invalid category projection item');
    return {
      id: item.id,
      name: item.name,
      groupId: item.groupId,
      group: item.group,
      icon: item.icon,
      isActive: item.isActive,
    };
  }
  if (!('name' in item)) throw new Error('Invalid named projection item');
  return {
    id: item.id,
    name: item.name,
    isActive: item.isActive,
  };
}

export function financeReferenceDatasetGenerationRef(input: {
  connectorId: string;
  dataset: FinanceReferenceDataset;
  sourceAsOf: string;
  schemaVersion: string;
  configVersion: number;
  items: readonly FinanceReferenceDatasetItem[];
}): string {
  const items = input.items
    .map((item) => {
      const value = projectionValue(input.dataset, item);
      return {
        sortKey: canonicalizeFinanceInsightV1(value),
        value,
      };
    })
    .sort((left, right) => (
      left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0
    ))
    .map(({ value }) => value);
  const digest = financeInsightDigestV1({
    connectorId: input.connectorId,
    dataset: input.dataset,
    sourceAsOf: input.sourceAsOf,
    schemaVersion: input.schemaVersion,
    configVersion: input.configVersion,
    items,
  });
  return `finance-dataset-v1:${digest.replace('sha256:', '')}`;
}
