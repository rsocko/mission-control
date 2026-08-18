import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';
import {
  COPILOT_CLI_PACKAGE_VERSION,
  COPILOT_CLI_RUNTIME_VERSIONS,
  COPILOT_SDK_PROTOCOL_VERSION,
  COPILOT_SDK_VERSION,
} from '@/lib/ai/copilot-runtime-contract';

describe('Copilot runtime contract', () => {
  it('derives package versions from the package manifest', () => {
    expect(COPILOT_SDK_VERSION).toBe(
      packageJson.devDependencies['@github/copilot-sdk'],
    );
    expect(COPILOT_CLI_PACKAGE_VERSION).toBe(
      packageJson.overrides['@github/copilot'],
    );
    expect(COPILOT_CLI_RUNTIME_VERSIONS).toContain(
      COPILOT_CLI_PACKAGE_VERSION,
    );
    expect(COPILOT_SDK_PROTOCOL_VERSION).toBe(3);
  });
});
