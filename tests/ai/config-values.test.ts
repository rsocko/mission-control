import { describe, expect, it } from 'vitest';
import {
  parseSavedAIProviderConfig,
  resolveAICompletionConfig,
} from '@/lib/ai/config-values';

describe('driver-free AI configuration values', () => {
  it.each([
    [
      'Azure OpenAI',
      { AI_PROVIDER: 'azure', AZURE_OPENAI_ENDPOINT: 'https://azure.example', AZURE_OPENAI_API_KEY: 'key' },
      { provider: 'azure', baseUrl: 'https://azure.example', configured: true },
    ],
    [
      'Bifrost',
      { AI_PROVIDER: 'bifrost', BIFROST_BASE_URL: 'https://bifrost.example', BIFROST_API_KEY: 'key' },
      { provider: 'bifrost', baseUrl: 'https://bifrost.example', configured: true },
    ],
    [
      'Ollama',
      { AI_PROVIDER: 'ollama' },
      { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', configured: true },
    ],
  ])('recognizes %s environment configuration', (_name, environment, expected) => {
    expect(resolveAICompletionConfig({}, environment)).toMatchObject(expected);
  });

  it('does not borrow an environment credential for a different saved endpoint', () => {
    expect(resolveAICompletionConfig(
      { provider: 'bifrost', baseUrl: 'https://saved.example' },
      { BIFROST_BASE_URL: 'https://environment.example', BIFROST_API_KEY: 'environment-key' },
    )).toMatchObject({
      baseUrl: 'https://saved.example',
      apiKey: '',
      configured: true,
    });
  });

  it('rejects arrays and malformed serialized settings', () => {
    expect(parseSavedAIProviderConfig([])).toEqual({});
    expect(parseSavedAIProviderConfig('{')).toEqual({});
  });
});
