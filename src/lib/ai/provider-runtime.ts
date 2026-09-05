import type { AIAdmission } from './admission-controller';
import { loadAIProviderConfiguration } from './provider-configuration-service';
import { createConfiguredAIProvider } from './provider-client';
import { createConfiguredAIRequestContext } from './provider-routing-core';
import type { AIFeatureId, SensitivityClass } from './types';

export async function getAsyncAIModel(
  featureId: AIFeatureId,
  options: {
    sources?: string[];
    sensitivityOverride?: SensitivityClass;
    correlationId?: string;
    admission?: AIAdmission;
  } = {},
) {
  const { resolved, routingPolicy } = await loadAIProviderConfiguration();
  const context = createConfiguredAIRequestContext(
    routingPolicy,
    featureId,
    options,
  );
  const provider = createConfiguredAIProvider(
    resolved,
    context,
    options.admission,
  );
  return {
    model: provider(resolved.model),
    context,
  };
}
