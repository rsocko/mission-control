import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_BRIDGE_MAX_MESSAGE_BYTES,
  NATIVE_CONTRACT_VERSION,
  SHARE_IMAGE_DEPENDENCY_ISSUE,
  apnsRegistrationRequestSchema,
  classifyNativeNavigation,
  createNativeBridgeError,
  createNativeBridgeSuccess,
  getNativeContractJsonSchema,
  isNativeBridgeMessageWithinLimit,
  isTrustedNativeBridgeDocument,
  nativeBootstrapResponseSchema,
  nativeBootstrapRequestSchema,
  nativeCredentialRotationRequestSchema,
  nativeCredentialRevocationRequestSchema,
  nativeLogoutRequestSchema,
  nativeCredentialSchema,
  normalizeNativeTrustedOrigin,
  parseNativeBridgeEvent,
  parseNativeBridgeRequest,
  parseNativeBridgeResponse,
  resolveNativeDeepLink,
  sendNativeBridgeRequest,
  shareSheetCaptureRequestSchema,
} from '@/lib/native/contract';

const requestId = '8cf177a0-e46a-46fa-824c-4c34004e2423';

describe('native bridge contract', () => {
  it('keeps the checked-in JSON Schema synchronized with the Zod contract', () => {
    const schemaPath = resolve(process.cwd(), 'contracts/mobile-ios-native-v1.schema.json');
    const checkedInSchema = JSON.parse(readFileSync(schemaPath, 'utf8')) as unknown;
    expect(checkedInSchema).toEqual(getNativeContractJsonSchema());
  });

  it('preserves security constraints in the language-neutral JSON Schema', () => {
    const contract = getNativeContractJsonSchema();
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validateCredential = ajv.compile(contract.$defs.NativeCredential);
    const validateBootstrap = ajv.compile(contract.$defs.NativeBootstrapResponse);
    const validateBridgeEvent = ajv.compile(contract.$defs.NativeBridgeEvent);
    const validateCapture = ajv.compile(contract.$defs.ShareSheetCaptureRequest);
    const validateApns = ajv.compile(contract.$defs.ApnsRegistrationRequest);

    const credentialBase = {
      credentialId: '83c45840-a47f-4269-aae9-5a3f4fbd220b',
      accessToken: 'a'.repeat(32),
      issuedAt: '2026-07-31T12:00:00.000Z',
    };
    expect(validateCredential({
      ...credentialBase,
      kind: 'share_extension',
      scopes: ['triage:capture'],
      expiresInSeconds: 3600,
    })).toBe(true);
    expect(validateCredential({
      ...credentialBase,
      kind: 'share_extension',
      scopes: ['triage:capture', 'push:register'],
      expiresInSeconds: 3600,
    })).toBe(false);
    expect(validateCredential({
      ...credentialBase,
      kind: 'installation',
      scopes: [
        'push:register',
        'push:unregister',
        'credentials:rotate',
        'credentials:revoke',
      ],
      expiresInSeconds: 0,
    })).toBe(false);

    expect(validateBootstrap({
      version: 1,
      requestId,
      ok: true,
      data: {
        trustedOrigin: 'https://mc.example.com',
        bridgeVersion: 1,
        installationCredential: {
          ...credentialBase,
          kind: 'installation',
          scopes: [
            'push:register',
            'push:unregister',
            'credentials:rotate',
            'credentials:revoke',
          ],
          expiresInSeconds: 3600,
        },
      },
    })).toBe(true);
    expect(validateBootstrap({
      version: 1,
      requestId,
      ok: true,
      data: {
        trustedOrigin: 'https://mc.example.com',
        bridgeVersion: 1,
        installationCredential: {
          ...credentialBase,
          kind: 'share_extension',
          scopes: ['triage:capture'],
          expiresInSeconds: 3600,
        },
      },
    })).toBe(false);
    expect(validateBootstrap({
      version: 1,
      requestId,
      ok: true,
      data: {
        trustedOrigin: 'https://999.999.999.999',
        bridgeVersion: 1,
        installationCredential: {
          ...credentialBase,
          kind: 'installation',
          scopes: [
            'push:register',
            'push:unregister',
            'credentials:rotate',
            'credentials:revoke',
          ],
          expiresInSeconds: 3600,
        },
      },
    })).toBe(false);
    expect(validateBootstrap({
      version: 1,
      requestId,
      ok: true,
      data: {
        trustedOrigin: 'https://mc.example.com:99999',
        bridgeVersion: 1,
        installationCredential: {
          ...credentialBase,
          kind: 'installation',
          scopes: [
            'push:register',
            'push:unregister',
            'credentials:rotate',
            'credentials:revoke',
          ],
          expiresInSeconds: 3600,
        },
      },
    })).toBe(false);
    expect(validateBootstrap({
      version: 1,
      requestId,
      ok: true,
      data: {
        trustedOrigin: 'https://mc.example.com.evil.test/path',
        bridgeVersion: 1,
        installationCredential: {
          ...credentialBase,
          kind: 'installation',
          scopes: [
            'push:register',
            'push:unregister',
            'credentials:rotate',
            'credentials:revoke',
          ],
          expiresInSeconds: 3600,
        },
      },
    })).toBe(false);

    const bridgeEventBase = {
      version: 1,
      requestId,
      action: 'pushRegistrationChanged',
    };
    expect(validateBridgeEvent({
      ...bridgeEventBase,
      payload: {
        authorization: 'authorized',
        state: 'registered',
        registrationId: 'c83d74ec-d4a1-45f7-8153-79fdb63cafb9',
      },
    })).toBe(true);
    expect(validateBridgeEvent({
      ...bridgeEventBase,
      payload: {
        authorization: 'authorized',
        state: 'registered',
      },
    })).toBe(false);
    expect(validateBridgeEvent({
      ...bridgeEventBase,
      payload: {
        authorization: 'denied',
        state: 'unregistered',
        registrationId: 'c83d74ec-d4a1-45f7-8153-79fdb63cafb9',
      },
    })).toBe(false);

    expect(validateCapture({
      version: 1,
      requestId,
      client: 'ios',
      contentType: 'url',
      url: 'ftp://example.com/payload',
    })).toBe(false);
    expect(validateCapture({
      version: 1,
      requestId,
      client: 'ios',
      contentType: 'url',
      url: 'https://',
    })).toBe(false);
    expect(validateCapture({
      version: 1,
      requestId,
      client: 'ios',
      contentType: 'text',
      text: '   ',
    })).toBe(false);
    const unicodeTitleCapture = {
      version: 1,
      requestId,
      client: 'ios',
      contentType: 'text',
      text: 'Shared text',
      title: '😀'.repeat(500),
    };
    expect(validateCapture(unicodeTitleCapture)).toBe(true);
    expect(shareSheetCaptureRequestSchema.safeParse(unicodeTitleCapture).success).toBe(true);
    const oversizedUnicodeTitleCapture = {
      ...unicodeTitleCapture,
      title: '😀'.repeat(501),
    };
    expect(validateCapture(oversizedUnicodeTitleCapture)).toBe(false);
    expect(shareSheetCaptureRequestSchema.safeParse(oversizedUnicodeTitleCapture).success).toBe(false);
    const paddedTextCapture = {
      version: 1,
      requestId,
      client: 'ios',
      contentType: 'text',
      text: `x${' '.repeat(200_000)}`,
    };
    expect(validateCapture(paddedTextCapture)).toBe(false);
    expect(shareSheetCaptureRequestSchema.safeParse(paddedTextCapture).success).toBe(false);
    expect(validateCapture({
      version: 1,
      requestId,
      client: 'ios',
      contentType: 'url',
      url: 'https://999.999.999.999/payload',
    })).toBe(false);
    expect(validateCapture({
      version: 1,
      requestId,
      client: 'ios',
      contentType: 'url',
      url: 'https://[::::]/payload',
    })).toBe(false);
    expect(validateApns({
      version: 1,
      requestId,
      installationId: '570ce945-1433-40f3-92c6-af7c14343acd',
      deviceToken: 'a'.repeat(65),
      environment: 'production',
      topic: 'com.example.missioncontrol',
      appVersion: '1.0.0',
      buildNumber: 42,
      locale: 'en-US',
      timeZone: 'America/New_York',
    })).toBe(false);
  });

  it.each([
    ['bootstrap', { webClientVersion: '1.0.0' }],
    ['requestPushPermission', { context: 'onboarding' }],
    ['hapticFeedback', { type: 'impact', intensity: 0.5 }],
    ['openURL', { url: 'https://example.com/article' }],
    ['setBadge', { count: 12 }],
  ])('accepts a valid %s request', (action, payload) => {
    expect(parseNativeBridgeRequest({
      version: NATIVE_CONTRACT_VERSION,
      requestId,
      action,
      payload,
    }).success).toBe(true);
  });

  it('rejects unsupported versions, actions, and undeclared fields', () => {
    expect(parseNativeBridgeRequest({
      version: 2,
      requestId,
      action: 'setBadge',
      payload: { count: 1 },
    }).success).toBe(false);
    expect(parseNativeBridgeRequest({
      version: 1,
      requestId,
      action: 'readKeychain',
      payload: {},
    }).success).toBe(false);
    expect(parseNativeBridgeRequest({
      version: 1,
      requestId,
      action: 'setBadge',
      payload: { count: 1 },
      accessToken: 'must-not-cross-the-bridge',
    }).success).toBe(false);
    expect(() => parseNativeBridgeRequest({
      version: 1,
      requestId,
      action: 'openURL',
      payload: { url: 'https://' },
    })).not.toThrow();
    expect(parseNativeBridgeRequest({
      version: 1,
      requestId,
      action: 'openURL',
      payload: { url: 'https://' },
    }).success).toBe(false);
    expect(parseNativeBridgeRequest({
      version: 1,
      requestId: '00000000-0000-0000-0000-000000000000',
      action: 'setBadge',
      payload: { count: 1 },
    }).success).toBe(false);
  });

  it('validates native events without exposing APNs tokens', () => {
    expect(parseNativeBridgeEvent({
      version: 1,
      requestId,
      action: 'pushRegistrationChanged',
      payload: {
        authorization: 'authorized',
        state: 'registered',
        registrationId: 'c83d74ec-d4a1-45f7-8153-79fdb63cafb9',
      },
    }).success).toBe(true);
    expect(parseNativeBridgeEvent({
      version: 1,
      requestId,
      action: 'pushRegistrationChanged',
      payload: {
        authorization: 'authorized',
        state: 'registered',
      },
    }).success).toBe(false);
    expect(parseNativeBridgeEvent({
      version: 1,
      requestId,
      action: 'pushRegistrationChanged',
      payload: {
        authorization: 'denied',
        state: 'unregistered',
        registrationId: 'c83d74ec-d4a1-45f7-8153-79fdb63cafb9',
      },
    }).success).toBe(false);
    expect(parseNativeBridgeEvent({
      version: 1,
      requestId,
      action: 'pushRegistrationChanged',
      payload: {
        authorization: 'authorized',
        state: 'registered',
        deviceToken: 'secret',
      },
    }).success).toBe(false);
  });

  it('creates and parses structured success and error responses', () => {
    const success = createNativeBridgeSuccess(
      'requestPushPermission',
      requestId,
      { authorization: 'authorized' },
    );
    const failure = createNativeBridgeError('requestPushPermission', requestId, {
      code: 'PERMISSION_DENIED',
      message: 'Notifications are disabled',
      retryable: false,
    });

    expect(parseNativeBridgeResponse(success).success).toBe(true);
    expect(parseNativeBridgeResponse(failure).success).toBe(true);
    expect(failure).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(parseNativeBridgeResponse(createNativeBridgeError('readKeychain', requestId, {
      code: 'UNSUPPORTED_ACTION',
      message: 'Unsupported bridge action',
      retryable: false,
    })).success).toBe(true);
    expect(parseNativeBridgeResponse({
      version: 1,
      requestId,
      action: 'bootstrap',
      ok: false,
      error: {
        code: 'NATIVE_FAILURE',
        message: 'Bootstrap failed',
        retryable: false,
        details: { accessToken: 'must-not-cross-the-bridge' },
      },
    }).success).toBe(false);
    expect(isNativeBridgeMessageWithinLimit({
      payload: 'x'.repeat(NATIVE_BRIDGE_MAX_MESSAGE_BYTES),
    })).toBe(false);
    expect(isNativeBridgeMessageWithinLimit({ payload: 'ok' })).toBe(true);
  });

  it('rejects a success payload that does not match its action', () => {
    expect(() => createNativeBridgeSuccess(
      'setBadge',
      requestId,
      { authorization: 'authorized' },
    )).toThrow();
    expect(() => createNativeBridgeSuccess(
      'bootstrap',
      requestId,
      {
        appVersion: '1.0.0',
        buildNumber: 42,
        authentication: 'authenticated',
        capabilities: ['push'],
        accessToken: 'must-not-cross-the-bridge',
      },
    )).toThrow();
    expect(() => createNativeBridgeSuccess(
      'bootstrap',
      requestId,
      {
        appVersion: '1.0.0',
        buildNumber: 42,
        authentication: 'authenticated',
        capabilities: ['push', 'push'],
      },
    )).toThrow();
  });

  it('sends validated requests only from the trusted document origin', () => {
    const messages: unknown[] = [];
    const request = {
      version: 1 as const,
      requestId,
      action: 'setBadge' as const,
      payload: { count: 3 },
    };

    expect(sendNativeBridgeRequest({
      configuredOrigin: 'https://mc.example.com',
      documentUrl: 'https://mc.example.com/today',
      request,
      transport: { postMessage: (message) => messages.push(message) },
    })).toBe(requestId);
    expect(messages).toEqual([request]);

    expect(() => sendNativeBridgeRequest({
      configuredOrigin: 'https://mc.example.com',
      documentUrl: 'https://evil.example.com/today',
      request,
      transport: { postMessage: (message) => messages.push(message) },
    })).toThrow('unavailable outside the trusted origin');
    expect(messages).toHaveLength(1);
  });
});

describe('native origin and navigation policy', () => {
  it('normalizes production HTTPS and loopback HTTP origins', () => {
    expect(normalizeNativeTrustedOrigin('https://mc.example.com')).toBe('https://mc.example.com');
    expect(normalizeNativeTrustedOrigin('http://localhost:3098')).toBe('http://localhost:3098');
  });

  it.each([
    'http://mc.example.com',
    'https://user:password@mc.example.com',
    'https://mc.example.com/path',
    'https://mc.example.com.',
    'https://mc.example.com?next=evil',
  ])('rejects an unsafe configured origin: %s', (origin) => {
    expect(() => normalizeNativeTrustedOrigin(origin)).toThrow();
  });

  it.each([
    'https://999.999.999.999',
    'https://[::::]',
  ])('rejects a malformed IP origin: %s', (origin) => {
    expect(() => normalizeNativeTrustedOrigin(origin)).toThrow();
  });

  it('requires exact origin equality for privileged bridge access', () => {
    expect(isTrustedNativeBridgeDocument(
      'https://mc.example.com/today',
      'https://mc.example.com',
    )).toBe(true);
    expect(isTrustedNativeBridgeDocument(
      'https://mc.example.com.evil.test/today',
      'https://mc.example.com',
    )).toBe(false);
    expect(isTrustedNativeBridgeDocument(
      'https://cdn.mc.example.com/today',
      'https://mc.example.com',
    )).toBe(false);
    expect(isTrustedNativeBridgeDocument(
      `https://${'user:password@'}mc.example.com/today`,
      'https://mc.example.com',
    )).toBe(false);
  });

  it('allows approved internal pages, externalizes web links, and blocks unsafe navigation', () => {
    expect(classifyNativeNavigation(
      'https://mc.example.com/triage?source=ios_share',
      'https://mc.example.com',
    ).disposition).toBe('allow');
    expect(classifyNativeNavigation(
      'https://github.com/octo-org/mission-control',
      'https://mc.example.com',
    ).disposition).toBe('external');
    expect(classifyNativeNavigation(
      'https://mc.example.com/api/tasks',
      'https://mc.example.com',
    )).toEqual({ disposition: 'reject', reason: 'path_not_allowed' });
    expect(classifyNativeNavigation(
      'javascript:alert(1)',
      'https://mc.example.com',
    )).toEqual({ disposition: 'reject', reason: 'blocked_scheme' });
    expect(classifyNativeNavigation(
      `https://${'user:password@'}mc.example.com/today`,
      'https://mc.example.com',
    )).toEqual({ disposition: 'reject', reason: 'invalid_url' });
  });

  it('maps only declared deep and universal links to trusted pages', () => {
    expect(resolveNativeDeepLink(
      'mc://view/today',
      'https://mc.example.com',
    )).toBe('https://mc.example.com/today');
    expect(resolveNativeDeepLink(
      'https://mc.example.com/capture',
      'https://mc.example.com',
    )).toBe('https://mc.example.com/capture');
    expect(resolveNativeDeepLink(
      'mc://admin/secrets',
      'https://mc.example.com',
    )).toBeNull();
    expect(resolveNativeDeepLink(
      'https://evil.example.com/today',
      'https://mc.example.com',
    )).toBeNull();
    expect(resolveNativeDeepLink(
      `https://${'user:password@'}mc.example.com/today`,
      'https://mc.example.com',
    )).toBeNull();
  });
});

describe('native authentication and API contracts', () => {
  const credentialBase = {
    credentialId: '83c45840-a47f-4269-aae9-5a3f4fbd220b',
    accessToken: 'a'.repeat(32),
    issuedAt: '2026-07-31T12:00:00.000Z',
  };

  it('restricts the shared extension credential to capture only', () => {
    expect(nativeCredentialSchema.safeParse({
      ...credentialBase,
      kind: 'share_extension',
      scopes: ['triage:capture'],
      expiresInSeconds: 30 * 24 * 60 * 60,
    }).success).toBe(true);
    expect(nativeCredentialSchema.safeParse({
      ...credentialBase,
      kind: 'share_extension',
      scopes: ['triage:capture', 'push:register'],
      expiresInSeconds: 30 * 24 * 60 * 60,
    }).success).toBe(false);
    expect(nativeCredentialSchema.safeParse({
      ...credentialBase,
      kind: 'installation',
      scopes: ['triage:capture'],
      expiresInSeconds: 90 * 24 * 60 * 60,
    }).success).toBe(false);
  });

  it('requires a single-use PKCE authorization exchange for bootstrap', () => {
    expect(nativeBootstrapRequestSchema.safeParse({
      version: 1,
      requestId,
      installationId: '570ce945-1433-40f3-92c6-af7c14343acd',
      authorizationCode: 'c'.repeat(32),
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'mc://auth/callback',
      appVersion: '1.0.0',
      buildNumber: 42,
    }).success).toBe(true);
    expect(nativeBootstrapRequestSchema.safeParse({
      version: 1,
      requestId,
      installationId: '570ce945-1433-40f3-92c6-af7c14343acd',
      authorizationCode: 'reusable-static-secret',
      codeVerifier: 'too-short',
      redirectUri: 'https://evil.example.com/callback',
      appVersion: '1.0.0',
      buildNumber: 42,
    }).success).toBe(false);
  });

  it('rejects non-positive lifetimes and misplaced bootstrap credentials', () => {
    expect(nativeCredentialSchema.safeParse({
      ...credentialBase,
      kind: 'installation',
      scopes: [
        'push:register',
        'push:unregister',
        'credentials:rotate',
        'credentials:revoke',
      ],
      expiresInSeconds: 0,
    }).success).toBe(false);

    expect(nativeBootstrapResponseSchema.safeParse({
      version: 1,
      requestId,
      ok: true,
      data: {
        trustedOrigin: 'https://mc.example.com',
        bridgeVersion: 1,
        installationCredential: {
          ...credentialBase,
          kind: 'share_extension',
          scopes: ['triage:capture'],
          expiresInSeconds: 30 * 24 * 60 * 60,
        },
      },
    }).success).toBe(false);
  });

  it('defines authenticated credential rotation, revocation, and logout requests', () => {
    const lifecycleBase = {
      version: 1,
      requestId,
      installationId: '570ce945-1433-40f3-92c6-af7c14343acd',
    };
    expect(nativeCredentialRotationRequestSchema.safeParse({
      ...lifecycleBase,
      credentialId: credentialBase.credentialId,
      credentialKind: 'share_extension',
    }).success).toBe(true);
    expect(nativeCredentialRevocationRequestSchema.safeParse({
      ...lifecycleBase,
      credentialId: credentialBase.credentialId,
      reason: 'logout',
    }).success).toBe(true);
    expect(nativeLogoutRequestSchema.safeParse({
      ...lifecycleBase,
    }).success).toBe(true);
    expect(nativeLogoutRequestSchema.safeParse({
      ...lifecycleBase,
      credentialIds: [credentialBase.credentialId],
    }).success).toBe(false);
  });

  it('validates APNs registration metadata and rejects malformed tokens', () => {
    const validRequest = {
      version: 1,
      requestId,
      installationId: '570ce945-1433-40f3-92c6-af7c14343acd',
      deviceToken: 'a'.repeat(64),
      environment: 'production',
      topic: 'com.example.missioncontrol',
      appVersion: '1.0.0',
      buildNumber: 42,
      locale: 'en-US',
      timeZone: 'America/New_York',
    };
    expect(apnsRegistrationRequestSchema.safeParse(validRequest).success).toBe(true);
    expect(apnsRegistrationRequestSchema.safeParse({
      ...validRequest,
      deviceToken: 'not-a-token',
    }).success).toBe(false);
    expect(apnsRegistrationRequestSchema.safeParse({
      ...validRequest,
      deviceToken: 'a'.repeat(65),
    }).success).toBe(false);
  });

  it('accepts URL and text Share Sheet captures and gates image capture', () => {
    expect(shareSheetCaptureRequestSchema.safeParse({
      version: 1,
      requestId,
      client: 'ios',
      contentType: 'url',
      url: 'https://example.com/async-retrospectives',
      title: 'Async retrospectives',
    }).success).toBe(true);
    expect(() => shareSheetCaptureRequestSchema.safeParse({
      version: 1,
      requestId,
      client: 'ios',
      contentType: 'url',
      url: 'https://',
    })).not.toThrow();
    expect(shareSheetCaptureRequestSchema.safeParse({
      version: 1,
      requestId,
      client: 'ios',
      contentType: 'url',
      url: 'https://',
    }).success).toBe(false);
    expect(shareSheetCaptureRequestSchema.safeParse({
      version: 1,
      requestId,
      client: 'ios',
      contentType: 'text',
      text: 'Draft priorities for Q4 planning.',
    }).success).toBe(true);
    expect(shareSheetCaptureRequestSchema.safeParse({
      version: 1,
      requestId,
      client: 'ios',
      contentType: 'image',
      imageData: '...',
    }).success).toBe(false);
    expect(SHARE_IMAGE_DEPENDENCY_ISSUE).toBe(1656);
  });
});
