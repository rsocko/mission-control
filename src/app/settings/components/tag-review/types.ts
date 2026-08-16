export interface ReviewTag {
  id: string;
  name: string;
  slug: string;
  type: string;
  source: string | null;
  sources: string[];
  sourceNames: string[];
  color: string | null;
  confirmed: boolean;
  usageCount: number;
  unifiedInto: string | null;
  listUsage: Array<{
    connectorInstanceId: string;
    sourceListId: string;
    usageCount: number;
  }>;
  sourceUsage: Array<{
    connectorType: string;
    usageCount: number;
  }>;
}

export interface SourceListInfo {
  id: string;
  connectorInstanceId: string;
  sourceId: string;
  name: string;
  type: string;
  selectedForSync?: boolean;
}

export interface ConnectorInfo {
  id: string;
  type: string;
  name: string;
  capabilities: {
    tagCreationMode?: string;
    tagScope?: string;
    tagWriteBack?: boolean;
  };
}

export type TagSort = 'usage-desc' | 'usage-asc' | 'name-asc' | 'name-desc';
export type MergeOrigin = 'selection' | 'suggestion';
export type MergeMode = 'merge' | 'unify';
