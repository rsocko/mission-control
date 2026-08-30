/**
 * Sensitivity resolution for indexed documents.
 *
 * A document's tier is decided by the *same* policy that gates AI egress, so
 * the index can never label a document less restrictively than the routing
 * policy would label a request carrying that document's text.
 */

import { getAIRoutingPolicy } from '@/lib/ai/config-resolver';
import { resolveSensitivity } from '@/lib/ai/sensitivity-policy';
import type { SemanticSensitivityResolver } from './projections';

/**
 * Builds a resolver backed by the live AI routing policy.
 *
 * `semantic-embedding` is the feature id the embedding path already uses, and
 * the connector kind is passed as a routing "source" so per-connector overrides
 * (finance, email, and the rest) apply unchanged.
 */
export function createPolicySensitivityResolver(): SemanticSensitivityResolver {
  return ({ connectorType }) => {
    const key = connectorType.trim().toLowerCase();
    // The policy read is itself cached by the config resolver, so this stays
    // cheap while still picking up a policy edit rather than pinning the tier
    // that was in force when the worker started.
    return resolveSensitivity('semantic-embedding', getAIRoutingPolicy(), {
      sources: key ? [key] : [],
    });
  };
}
