import {
  AIRoutingPolicyValidationError,
  AISensitivityOverrideError,
  DEFAULT_AI_ROUTING_POLICY,
  AIProviderEndpointValidationError,
  createAIRequestContext,
  extractBifrostRoutingMetadata,
  parseBifrostModelId,
  assertAIProviderCanReceive,
  resolveSensitivity,
  resolveAIRouteOutcome,
  validateProviderEndpoint,
  validateAIRoutingPolicy,
} from '@/lib/ai/sensitivity-policy';

describe('AI sensitivity policy', () => {
  it('defines valid, non-empty policies for every sensitivity class', () => {
    expect(validateAIRoutingPolicy(DEFAULT_AI_ROUTING_POLICY)).toEqual(DEFAULT_AI_ROUTING_POLICY);
    expect(DEFAULT_AI_ROUTING_POLICY.policies['local-only'].allowedRoutes).toEqual(['ollama']);
    expect(DEFAULT_AI_ROUTING_POLICY.policies.restricted.allowedRoutes).toEqual([
      'ollama',
      'azure-private',
    ]);
    expect(DEFAULT_AI_ROUTING_POLICY.policies.standard.allowedRoutes).toContain('bifrost-copilot');
    expect(resolveSensitivity('day-planning', DEFAULT_AI_ROUTING_POLICY)).toBe('restricted');
  });

  it('resolves mixed sources to the most restrictive source policy', () => {
    const policy = {
      ...DEFAULT_AI_ROUTING_POLICY,
      sourceDefaults: {
        public: 'standard' as const,
        finance: 'restricted' as const,
        private: 'local-only' as const,
      },
    };

    expect(resolveSensitivity('smart-priority', policy, {
      sources: ['public', 'finance'],
    })).toBe('restricted');
    expect(resolveSensitivity('smart-priority', policy, {
      sources: ['finance', 'private'],
    })).toBe('local-only');
  });

  it('allows stricter overrides and rejects relaxation', () => {
    expect(resolveSensitivity('smart-priority', DEFAULT_AI_ROUTING_POLICY, {
      override: 'local-only',
    })).toBe('local-only');

    expect(() => resolveSensitivity('document-intake', DEFAULT_AI_ROUTING_POLICY, {
      override: 'standard',
    })).toThrow(AISensitivityOverrideError);
  });

  it('rejects saved feature defaults that weaken built-in classification', () => {
    const policy = structuredClone(DEFAULT_AI_ROUTING_POLICY);
    policy.featureDefaults['document-intake'] = 'standard';

    expect(() => validateAIRoutingPolicy(policy)).toThrow(AIRoutingPolicyValidationError);
    try {
      validateAIRoutingPolicy(policy);
    } catch (error) {
      expect((error as AIRoutingPolicyValidationError).issues).toContain(
        'feature "document-intake" cannot be less restrictive than its built-in default',
      );
    }
  });

  it('classifies canonical sensitive connectors and unknown sources conservatively', () => {
    expect(resolveSensitivity('smart-priority', DEFAULT_AI_ROUTING_POLICY, {
      sources: ['outlook-email'],
    })).toBe('restricted');
    expect(resolveSensitivity('smart-priority', DEFAULT_AI_ROUTING_POLICY, {
      sources: ['monarch-money'],
    })).toBe('restricted');
    expect(resolveSensitivity('smart-priority', DEFAULT_AI_ROUTING_POLICY, {
      sources: ['finance'],
    })).toBe('restricted');
    expect(resolveSensitivity('smart-priority', DEFAULT_AI_ROUTING_POLICY, {
      sources: ['connector-installed-after-this-release'],
    })).toBe('restricted');

    const downgraded = structuredClone(DEFAULT_AI_ROUTING_POLICY);
    downgraded.sourceDefaults['connector-installed-after-this-release'] = 'standard';
    expect(() => validateAIRoutingPolicy(downgraded)).toThrow(
      /cannot be less restrictive than its built-in default/,
    );
  });

  it('rejects empty, duplicate, unknown, and class-weakening route policies', () => {
    const invalid = structuredClone(DEFAULT_AI_ROUTING_POLICY);
    invalid.policies['local-only'].allowedRoutes = [];
    invalid.policies.restricted.allowedRoutes = ['openai', 'openai'];

    expect(() => validateAIRoutingPolicy(invalid)).toThrow(AIRoutingPolicyValidationError);
    try {
      validateAIRoutingPolicy(invalid);
    } catch (error) {
      expect(error).toBeInstanceOf(AIRoutingPolicyValidationError);
      expect((error as AIRoutingPolicyValidationError).issues).toEqual(expect.arrayContaining([
        'local-only must include at least one route',
        'restricted contains duplicate routes',
        'openai is not permitted for restricted',
      ]));
    }
  });

  it('reports allowed fallback and rejects a provider outside the resolved allowlist', () => {
    const context = createAIRequestContext(
      'smart-priority',
      DEFAULT_AI_ROUTING_POLICY,
      {
        override: 'local-only',
        correlationId: 'correlation-1',
      },
    );

    expect(resolveAIRouteOutcome(context, 'bifrost', 'llama3.1', {
      'x-bifrost-provider': 'ollama',
      'x-bifrost-model': 'llama3.1:8b',
      'x-bifrost-fallback': 'true',
    })).toMatchObject({
      provider: 'ollama',
      model: 'llama3.1:8b',
      fallbackOccurred: true,
    });

    expect(() => resolveAIRouteOutcome(context, 'bifrost', 'gpt-4.1', {
      'x-bifrost-provider': 'copilot',
    })).toThrow(/not allowed for local-only/);
  });

  it('does not claim fallback for a directly selected allowed provider', () => {
    const context = createAIRequestContext(
      'smart-priority',
      DEFAULT_AI_ROUTING_POLICY,
      { correlationId: 'correlation-2' },
    );

    expect(resolveAIRouteOutcome(context, 'openai', 'gpt-4.1').fallbackOccurred).toBe(false);
  });

  it('derives an allowed Bifrost route from a provider-qualified model', () => {
    const context = createAIRequestContext(
      'houston-chat',
      DEFAULT_AI_ROUTING_POLICY,
      { correlationId: 'correlation-bifrost-azure' },
    );

    expect(parseBifrostModelId('azure/gpt-4o-mini')).toEqual({
      provider: 'azure',
      model: 'gpt-4o-mini',
      route: 'azure-private',
    });
    expect(parseBifrostModelId('ollama/nomic-embed-text:latest')?.route).toBe('ollama');
    expect(resolveAIRouteOutcome(context, 'bifrost', 'azure/gpt-4o-mini')).toMatchObject({
      provider: 'azure',
      model: 'gpt-4o-mini',
      fallbackOccurred: false,
    });
  });

  it('uses Bifrost response metadata when available', () => {
    const context = createAIRequestContext(
      'houston-chat',
      DEFAULT_AI_ROUTING_POLICY,
      { correlationId: 'correlation-bifrost-metadata' },
    );
    const metadata = extractBifrostRoutingMetadata({
      extra_fields: {
        provider: 'azure',
        routing_info: {
          provider: 'azure',
          model: 'gpt-4o-mini',
          fallback_index: 1,
        },
      },
    });

    expect(resolveAIRouteOutcome(
      context,
      'bifrost',
      'azure/gpt-4o',
      undefined,
      metadata,
    )).toMatchObject({
      provider: 'azure',
      model: 'gpt-4o-mini',
      fallbackOccurred: true,
    });
  });

  it('rejects missing or unknown Bifrost route metadata', () => {
    const context = createAIRequestContext(
      'smart-priority',
      DEFAULT_AI_ROUTING_POLICY,
      { correlationId: 'correlation-3' },
    );

    expect(() => resolveAIRouteOutcome(context, 'bifrost', 'gpt-4.1')).toThrow(
      /not allowed/,
    );
    expect(() => resolveAIRouteOutcome(context, 'bifrost', 'gpt-4.1', {
      'x-bifrost-provider': 'unrecognized-provider',
      'x-bifrost-model': 'gpt-4.1',
    })).toThrow(/not allowed/);
  });

  it('only assigns trusted direct provider endpoint identities', () => {
    expect(() => validateProviderEndpoint('ollama', 'http://localhost:11434/v1')).not.toThrow();
    expect(() => validateProviderEndpoint('ollama', 'https://example.com/v1'))
      .toThrow(AIProviderEndpointValidationError);
    expect(() => validateProviderEndpoint('azure', 'https://attacker.example/v1'))
      .toThrow(AIProviderEndpointValidationError);
    expect(() => validateProviderEndpoint('azure', 'https://public.openai.azure.com/v1'))
      .toThrow(AIProviderEndpointValidationError);
    vi.stubEnv('AZURE_OPENAI_ENDPOINT', 'https://deployment.openai.azure.com/v1');
    expect(() => validateProviderEndpoint('azure', 'https://deployment.openai.azure.com/v1'))
      .not.toThrow();
    expect(() => validateProviderEndpoint('openai', 'http://api.example.com/v1'))
      .toThrow(AIProviderEndpointValidationError);
    expect(() => validateProviderEndpoint('openai', 'http://localhost:8080/v1', true))
      .toThrow(AIProviderEndpointValidationError);
    expect(() => validateProviderEndpoint('bifrost', 'http://10.0.0.8:8080/v1'))
      .toThrow(AIProviderEndpointValidationError);
    expect(() => validateProviderEndpoint(
      'bifrost',
      'https://user:secret@bifrost.example/v1',
    )).toThrow(/embedded credentials/);
  });

  it('never sends local-only content through a gateway', () => {
    const context = createAIRequestContext(
      'document-intake',
      DEFAULT_AI_ROUTING_POLICY,
      { override: 'local-only', correlationId: 'correlation-4' },
    );

    expect(() => assertAIProviderCanReceive(context, 'bifrost', 'bifrost-copilot'))
      .toThrow(/not allowed for local-only/);
    expect(() => assertAIProviderCanReceive(context, 'bifrost', 'ollama'))
      .toThrow(/not allowed for local-only/);
  });
});
