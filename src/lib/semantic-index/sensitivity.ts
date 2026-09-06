/**
 * Sensitivity resolution for indexed documents.
 *
 * A document's tier is decided by the *same* policy that gates AI egress, so
 * the index can never label a document less restrictively than the routing
 * policy would label a request carrying that document's text.
 */

import { resolveSensitivity } from '@/lib/ai/sensitivity-policy';
import type { AIRoutingPolicyConfig } from '@/lib/ai/types';
import type { SemanticSensitivityResolver } from './projections';

/**
 * Builds a resolver backed by the live AI routing policy.
 *
 * `semantic-embedding` is the feature id the embedding path already uses, and
 * the connector kind is passed as a routing "source" so per-connector overrides
 * (finance, email, and the rest) apply unchanged.
 */
export function createPolicySensitivityResolver(
  getRoutingPolicy: () => AIRoutingPolicyConfig,
): SemanticSensitivityResolver {
  return ({ connectorType }) => {
    const key = connectorType.trim().toLowerCase();
    return resolveSensitivity('semantic-embedding', getRoutingPolicy(), {
      sources: key ? [key] : [],
    });
  };
}
