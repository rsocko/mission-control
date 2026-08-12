import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';

interface ConnectorState {
  type: string;
  enabled: boolean;
}

const CONNECTOR_FEATURES: Array<{ label: string; types: string[] }> = [
  { label: 'Microsoft Todo', types: ['microsoft-todo'] },
  { label: 'GitHub Issues', types: ['github-issues'] },
  { label: 'RyMessage Messaging', types: ['rymessage'] },
  { label: 'Outlook Calendar', types: ['outlook-calendar'] },
  { label: 'Outlook Email', types: ['outlook-email'] },
  { label: 'Tyrion', types: [...FINANCE_PROVIDER_ALIASES] },
];

export function getDisabledConnectorFeatures(configs: ConnectorState[]): string[] {
  return CONNECTOR_FEATURES
    .filter(({ types }) => {
      const matchingConfigs = configs.filter(config => types.includes(config.type));
      return matchingConfigs.length > 0 && matchingConfigs.every(config => !config.enabled);
    })
    .map(({ label }) => label);
}
