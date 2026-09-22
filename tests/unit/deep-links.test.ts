import { describe, expect, it } from 'vitest';
import {
  getDeepLinkInfo,
  getLinkedResourceDeepLinkInfo,
} from '@/lib/utils/deep-links';

describe('linked resource deep links', () => {
  it('maps an Outlook linked resource to the Outlook action', () => {
    expect(getLinkedResourceDeepLinkInfo([{
      applicationName: 'Microsoft Outlook',
      displayName: 'Flagged email',
      webUrl: 'https://outlook.office.com/mail/deeplink/read/id',
    }])).toEqual({
      url: 'https://outlook.office.com/mail/deeplink/read/id',
      label: 'Outlook',
      icon: '/icons/connectors/outlook.svg',
    });
  });

  it('supports other linked applications without changing their identity', () => {
    expect(getLinkedResourceDeepLinkInfo([{
      applicationName: 'Partner app',
      displayName: 'Related item',
      webUrl: 'https://example.com/items/1',
    }])).toEqual({
      url: 'https://example.com/items/1',
      label: 'Partner app',
    });
  });

  it('ignores self-links and unsafe URLs', () => {
    expect(getLinkedResourceDeepLinkInfo([
      {
        applicationName: 'Mission Control',
        webUrl: 'https://mission-control.example/tasks/1',
      },
      {
        applicationName: 'Unsafe',
        webUrl: 'javascript:alert(1)',
      },
    ])).toBeNull();
  });

  it('leaves existing connector deep links available as a fallback', () => {
    expect(getLinkedResourceDeepLinkInfo(undefined)).toBeNull();
    expect(getDeepLinkInfo('github-issues', 'acme/widgets:7')).toEqual({
      url: 'https://github.com/acme/widgets/issues/7',
      label: 'GitHub',
      icon: '/icons/connectors/github.svg',
    });
  });
});
