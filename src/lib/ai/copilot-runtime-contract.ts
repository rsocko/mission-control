import packageJson from '../../../package.json';

export const COPILOT_SDK_VERSION =
  packageJson.devDependencies['@github/copilot-sdk'];
export const COPILOT_CLI_PACKAGE_VERSION =
  packageJson.overrides['@github/copilot'];
export const COPILOT_CLI_RUNTIME_VERSIONS: readonly string[] = [
  '1.0.75',
  COPILOT_CLI_PACKAGE_VERSION,
];
export const COPILOT_SDK_PROTOCOL_VERSION = 3;
