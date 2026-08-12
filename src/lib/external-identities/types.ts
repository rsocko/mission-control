import type {
  ExternalBindingType,
  ExternalEntityType,
  ExternalLocatorSource,
  GitHubCollisionCategory,
} from '@/db/schema';

export interface ExternalEntityIdentity {
  provider: string;
  hostKey: string;
  entityType: ExternalEntityType;
  stableId: string;
}

export type ExternalEntityKey = Readonly<ExternalEntityIdentity>;

export interface ExternalEntityRecord {
  id: string;
  identity: ExternalEntityIdentity;
  identityVersion: number;
  nextLocatorRevision: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ExternalEntityUpsert {
  identity: ExternalEntityIdentity;
  observedAt: string;
}

export interface ExternalEntityLocatorEvidence {
  owner: string;
  repository: string;
  issueNumber?: number;
  apiUrl?: string;
  webUrl?: string;
}

export interface NormalizedExternalEntityLocator {
  owner: string;
  repository: string;
  ownerKey: string;
  repositoryKey: string;
  issueNumber: number | null;
  apiUrl: string | null;
  webUrl: string | null;
}

export interface ExternalEntityLocatorRecord extends NormalizedExternalEntityLocator {
  id: string;
  externalEntityId: string;
  repositoryEntityId: string | null;
  validFrom: string;
  validTo: string | null;
  lastSeenAt: string;
  observationSource: ExternalLocatorSource;
  locatorRevision: number;
}

export interface ExternalEntityLocatorObservation {
  entityId: string;
  identity: ExternalEntityIdentity;
  locator: ExternalEntityLocatorEvidence;
  repositoryEntityId?: string | null;
  observedAt: string;
}

export interface ExternalEntityLocatorPreflight {
  state: 'unchanged' | 'update' | 'collision';
  locator: NormalizedExternalEntityLocator;
  current: ExternalEntityLocatorRecord | null;
  collisionCategory?: GitHubCollisionCategory;
  conflictingEntityId?: string;
}

export interface ExternalEntityLocatorObservationResult extends ExternalEntityLocatorPreflight {
  locatorRecord: ExternalEntityLocatorRecord | null;
}

export interface ExternalIdentityObservation {
  identity: ExternalEntityIdentity;
  locator: ExternalEntityLocatorEvidence;
  observationSource: ExternalLocatorSource;
  observedAt: string;
}

export interface ExternalIdentityEvidence {
  entity: ExternalIdentityObservation;
  repository?: ExternalIdentityObservation;
}

export interface ExternalIdentityBindingTarget {
  connectorInstanceId: string;
  bindingType: ExternalBindingType;
  localId: string;
  legacyIdentity: string;
}

export interface ExternalIdentityWrite {
  target: ExternalIdentityBindingTarget;
  evidence: ExternalIdentityEvidence;
}

export type ExternalIdentityWriteState = 'bound' | 'collision' | 'skipped';

export interface ExternalIdentityWriteResult {
  target: ExternalIdentityBindingTarget;
  state: ExternalIdentityWriteState;
  externalEntityId?: string;
  collisionCategory?: GitHubCollisionCategory;
}

export interface ExternalIdentityCollisionInput {
  connectorInstanceId: string;
  category: GitHubCollisionCategory;
  bindingType: ExternalBindingType;
  localIds: string[];
  externalEntityIds: string[];
  legacyIdentity?: string;
  observedAt: string;
}

export interface ExternalIdentityCollisionRecord {
  id: string;
  connectorInstanceId: string;
  category: GitHubCollisionCategory;
  fingerprint: string;
  bindingType: ExternalBindingType;
  localIds: string[];
  externalEntityIds: string[];
  legacyIdentityDigest: string | null;
  state: 'open' | 'resolved' | 'accepted_legacy_only';
  firstSeenAt: string;
  lastSeenAt: string;
}
