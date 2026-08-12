import { z } from 'zod';

export const NATIVE_CONTRACT_VERSION = 1 as const;
export const NATIVE_BRIDGE_MAX_MESSAGE_BYTES = 64 * 1024;
export const SHARE_IMAGE_DEPENDENCY_ISSUE = 1656 as const;

const RFC_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidSchema = z.string().uuid().regex(RFC_UUID_PATTERN);
const requestIdSchema = uuidSchema;
const isoDateSchema = z.iso.datetime({ offset: true });
const VALID_PORT = '(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])';
const DNS_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const DNS_HOST = `(?:${DNS_LABEL}\\.)*[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?`;
const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])';
const IPV4_HOST = `(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}`;
const WEB_HOST = `(?:${DNS_HOST}|${IPV4_HOST})`;
const HTTP_URL_PATTERN = new RegExp(`^https?://${WEB_HOST}(?::${VALID_PORT})?(?:[/?#].*)?$`);
const TRUSTED_ORIGIN_PATTERN = new RegExp(
  `^(?:https://${WEB_HOST}(?::${VALID_PORT})?|http://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::${VALID_PORT})?)$`,
);
const codePointBoundedString = (max: number, min = 0) => z.string()
  .refine((value) => {
    const length = Array.from(value).length;
    return length >= min && length <= max;
  }, `String must contain between ${min} and ${max} Unicode code points`)
  .meta({ minLength: min, maxLength: max });
const nonBlankString = (max: number, min = 1) => codePointBoundedString(max, min)
  .regex(/^\S(?:[\s\S]*\S)?$/);
const httpUrlSchema = z.url()
  .regex(HTTP_URL_PATTERN)
  .refine((value) => Array.from(value).length <= 2048, 'URL exceeds 2048 Unicode code points')
  .meta({ maxLength: 2048 })
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'https:' || protocol === 'http:';
    } catch {
      return false;
    }
  }, 'URL must use HTTP or HTTPS');

const bridgeBase = {
  version: z.literal(NATIVE_CONTRACT_VERSION),
  requestId: requestIdSchema,
};

function bridgeRequest<const Action extends string, Payload extends z.ZodType>(
  action: Action,
  payload: Payload,
) {
  return z.object({
    ...bridgeBase,
    action: z.literal(action),
    payload,
  }).strict();
}

export const nativeBridgeRequestSchema = z.discriminatedUnion('action', [
  bridgeRequest('bootstrap', z.object({
    webClientVersion: nonBlankString(64),
  }).strict()),
  bridgeRequest('requestPushPermission', z.object({
    context: z.enum(['onboarding', 'notifications', 'settings']),
  }).strict()),
  bridgeRequest('hapticFeedback', z.object({
    type: z.enum(['success', 'impact', 'warning', 'selection']),
    intensity: z.number().min(0).max(1).optional(),
  }).strict()),
  bridgeRequest('openURL', z.object({
    url: httpUrlSchema,
  }).strict()),
  bridgeRequest('setBadge', z.object({
    count: z.number().int().min(0).max(999),
  }).strict()),
]);

const pushAuthorizationSchema = z.enum([
  'notDetermined',
  'denied',
  'authorized',
  'provisional',
]);

const pushRegistrationChangedPayloadSchema = z.discriminatedUnion('state', [
  z.object({
    authorization: pushAuthorizationSchema,
    state: z.literal('unregistered'),
  }).strict(),
  z.object({
    authorization: pushAuthorizationSchema,
    state: z.literal('registering'),
  }).strict(),
  z.object({
    authorization: pushAuthorizationSchema,
    state: z.literal('registered'),
    registrationId: uuidSchema,
  }).strict(),
  z.object({
    authorization: pushAuthorizationSchema,
    state: z.literal('failed'),
  }).strict(),
]);

export const nativeBridgeEventSchema = z.discriminatedUnion('action', [
  bridgeRequest('authenticationChanged', z.object({
    state: z.enum(['authenticated', 'unauthenticated', 'expired']),
  }).strict()),
  bridgeRequest('networkStatus', z.object({
    status: z.enum(['online', 'offline']),
  }).strict()),
  bridgeRequest('pushRegistrationChanged', pushRegistrationChangedPayloadSchema),
  bridgeRequest('shareCaptureCompleted', z.object({
    captureRequestId: requestIdSchema,
    status: z.enum(['created', 'duplicate']),
    itemId: nonBlankString(128),
  }).strict()),
]);

export const nativeBridgeErrorCodeSchema = z.enum([
  'INVALID_MESSAGE',
  'UNSUPPORTED_VERSION',
  'UNSUPPORTED_ACTION',
  'UNTRUSTED_ORIGIN',
  'INVALID_NAVIGATION',
  'NOT_AUTHENTICATED',
  'PERMISSION_DENIED',
  'TIMEOUT',
  'NATIVE_FAILURE',
]);

export const nativeBridgeErrorSchema = z.object({
  code: nativeBridgeErrorCodeSchema,
  message: nonBlankString(512),
  retryable: z.boolean(),
}).strict();

export const nativeBridgeActionSchema = z.enum([
  'bootstrap',
  'requestPushPermission',
  'hapticFeedback',
  'openURL',
  'setBadge',
]);

function bridgeSuccessResponse<const Action extends string, Result extends z.ZodType>(
  action: Action,
  result: Result,
) {
  return z.object({
    ...bridgeBase,
    action: z.literal(action),
    ok: z.literal(true),
    result,
  }).strict();
}

const nativeBridgeSuccessResponseSchema = z.discriminatedUnion('action', [
  bridgeSuccessResponse('bootstrap', z.object({
    appVersion: nonBlankString(64),
    buildNumber: z.number().int().positive(),
    authentication: z.enum(['authenticated', 'unauthenticated', 'expired']),
    capabilities: z.array(z.enum([
      'badge',
      'externalLinks',
      'haptics',
      'push',
      'shareCaptureStatus',
    ])).max(5).refine(
      (capabilities) => new Set(capabilities).size === capabilities.length,
      'Capabilities must be unique',
    ).meta({ uniqueItems: true }),
  }).strict()),
  bridgeSuccessResponse('requestPushPermission', z.object({
    authorization: z.enum(['notDetermined', 'denied', 'authorized', 'provisional']),
  }).strict()),
  bridgeSuccessResponse('hapticFeedback', z.object({
    delivered: z.boolean(),
  }).strict()),
  bridgeSuccessResponse('openURL', z.object({
    opened: z.boolean(),
  }).strict()),
  bridgeSuccessResponse('setBadge', z.object({
    count: z.number().int().min(0).max(999),
  }).strict()),
]);

export const nativeBridgeResponseSchema = z.union([
  nativeBridgeSuccessResponseSchema,
  z.object({
    ...bridgeBase,
    action: nonBlankString(128),
    ok: z.literal(false),
    error: nativeBridgeErrorSchema,
  }).strict(),
]);

export type NativeBridgeRequest = z.infer<typeof nativeBridgeRequestSchema>;
export type NativeBridgeEvent = z.infer<typeof nativeBridgeEventSchema>;
export type NativeBridgeError = z.infer<typeof nativeBridgeErrorSchema>;
export type NativeBridgeResponse = z.infer<typeof nativeBridgeResponseSchema>;

export function isNativeBridgeMessageWithinLimit(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string'
      && new TextEncoder().encode(serialized).byteLength <= NATIVE_BRIDGE_MAX_MESSAGE_BYTES;
  } catch {
    return false;
  }
}

function sizeLimitedNativeBridgeSchema<Schema extends z.ZodType>(schema: Schema) {
  return z.unknown()
    .refine(
      isNativeBridgeMessageWithinLimit,
      `Native bridge message exceeds ${NATIVE_BRIDGE_MAX_MESSAGE_BYTES} bytes`,
    )
    .pipe(schema);
}

const nativeBridgeRequestParserSchema = sizeLimitedNativeBridgeSchema(nativeBridgeRequestSchema);
const nativeBridgeEventParserSchema = sizeLimitedNativeBridgeSchema(nativeBridgeEventSchema);
const nativeBridgeResponseParserSchema = sizeLimitedNativeBridgeSchema(nativeBridgeResponseSchema);

export interface NativeBridgeTransport {
  postMessage(message: NativeBridgeRequest): void;
}

export function parseNativeBridgeRequest(value: unknown) {
  return nativeBridgeRequestParserSchema.safeParse(value);
}

export function parseNativeBridgeEvent(value: unknown) {
  return nativeBridgeEventParserSchema.safeParse(value);
}

export function parseNativeBridgeResponse(value: unknown) {
  return nativeBridgeResponseParserSchema.safeParse(value);
}

export function sendNativeBridgeRequest(options: {
  configuredOrigin: string;
  documentUrl: string;
  request: NativeBridgeRequest;
  transport: NativeBridgeTransport;
}): string {
  if (!isTrustedNativeBridgeDocument(options.documentUrl, options.configuredOrigin)) {
    throw new Error('Native bridge is unavailable outside the trusted origin');
  }

  const request = nativeBridgeRequestParserSchema.parse(options.request);

  options.transport.postMessage(request);
  return request.requestId;
}

export function createNativeBridgeSuccess(
  action: z.infer<typeof nativeBridgeActionSchema>,
  requestId: string,
  result: unknown,
): NativeBridgeResponse {
  return nativeBridgeResponseParserSchema.parse({
    version: NATIVE_CONTRACT_VERSION,
    requestId,
    action,
    ok: true,
    result,
  });
}

export function createNativeBridgeError(
  action: string,
  requestId: string,
  error: NativeBridgeError,
): NativeBridgeResponse {
  return nativeBridgeResponseParserSchema.parse({
    version: NATIVE_CONTRACT_VERSION,
    requestId,
    action,
    ok: false,
    error,
  });
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normalizeNativeTrustedOrigin(configuredOrigin: string): string {
  if (!TRUSTED_ORIGIN_PATTERN.test(configuredOrigin)) {
    throw new Error('Trusted origin must be a canonical HTTPS or loopback HTTP origin');
  }

  const url = new URL(configuredOrigin);
  const isLoopback = LOOPBACK_HOSTNAMES.has(url.hostname);

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('Trusted origin must use HTTPS outside loopback development');
  }
  if (
    url.username
    || url.password
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search
    || url.hash
  ) {
    throw new Error('Trusted origin must not include credentials, a path, query, or fragment');
  }

  return url.origin;
}

export function isTrustedNativeBridgeDocument(
  documentUrl: string,
  configuredOrigin: string,
): boolean {
  try {
    const url = new URL(documentUrl);
    return !url.username
      && !url.password
      && url.origin === normalizeNativeTrustedOrigin(configuredOrigin);
  } catch {
    return false;
  }
}

export const NATIVE_WEB_PATH_ALLOWLIST = [
  '/',
  '/ai',
  '/capture',
  '/goals',
  '/insights',
  '/notifications',
  '/projects',
  '/quick-sort',
  '/routines',
  '/settings',
  '/today',
  '/triage',
] as const;

function isAllowedNativeWebPath(pathname: string): boolean {
  return NATIVE_WEB_PATH_ALLOWLIST.some(
    (allowedPath) => pathname === allowedPath
      || (allowedPath !== '/' && pathname.startsWith(`${allowedPath}/`)),
  );
}

export type NativeNavigationDecision =
  | { disposition: 'allow'; url: string }
  | { disposition: 'external'; url: string }
  | { disposition: 'reject'; reason: 'invalid_url' | 'blocked_scheme' | 'path_not_allowed' };

export function classifyNativeNavigation(
  target: string,
  configuredOrigin: string,
): NativeNavigationDecision {
  let url: URL;
  let trustedOrigin: string;
  try {
    url = new URL(target);
    trustedOrigin = normalizeNativeTrustedOrigin(configuredOrigin);
  } catch {
    return { disposition: 'reject', reason: 'invalid_url' };
  }

  if (url.username || url.password) {
    return { disposition: 'reject', reason: 'invalid_url' };
  }

  if (url.origin === trustedOrigin) {
    return isAllowedNativeWebPath(url.pathname)
      ? { disposition: 'allow', url: url.toString() }
      : { disposition: 'reject', reason: 'path_not_allowed' };
  }

  if (url.protocol === 'https:' || url.protocol === 'http:') {
    return { disposition: 'external', url: url.toString() };
  }

  return { disposition: 'reject', reason: 'blocked_scheme' };
}

const deepLinkRouteMap = new Map([
  ['mc://view/today', '/today'],
  ['mc://view/triage', '/triage'],
  ['mc://view/capture', '/capture'],
  ['mc://view/quick-sort', '/quick-sort'],
  ['mc://view/houston', '/ai'],
  ['mc://capture', '/capture'],
]);

export function resolveNativeDeepLink(
  target: string,
  configuredOrigin: string,
): string | null {
  let trustedOrigin: string;
  try {
    trustedOrigin = normalizeNativeTrustedOrigin(configuredOrigin);
  } catch {
    return null;
  }

  const mappedPath = deepLinkRouteMap.get(target);
  if (mappedPath) {
    return new URL(mappedPath, trustedOrigin).toString();
  }

  const decision = classifyNativeNavigation(target, trustedOrigin);
  return decision.disposition === 'allow' ? decision.url : null;
}

export const nativeCredentialScopeSchema = z.enum([
  'triage:capture',
  'push:register',
  'push:unregister',
  'credentials:rotate',
  'credentials:revoke',
]);

const credentialBase = {
  credentialId: uuidSchema,
  accessToken: z.string().min(32).max(4096).regex(/^\S+$/),
  issuedAt: isoDateSchema,
};

export const nativeInstallationCredentialSchema = z.object({
  ...credentialBase,
  kind: z.literal('installation'),
  scopes: z.tuple([
    z.literal('push:register'),
    z.literal('push:unregister'),
    z.literal('credentials:rotate'),
    z.literal('credentials:revoke'),
  ]),
  expiresInSeconds: z.number().int().positive().max(90 * 24 * 60 * 60),
}).strict();

export const nativeShareExtensionCredentialSchema = z.object({
  ...credentialBase,
  kind: z.literal('share_extension'),
  scopes: z.tuple([z.literal('triage:capture')]),
  expiresInSeconds: z.number().int().positive().max(30 * 24 * 60 * 60),
}).strict();

export const nativeCredentialSchema = z.discriminatedUnion('kind', [
  nativeInstallationCredentialSchema,
  nativeShareExtensionCredentialSchema,
]);

export const nativeBootstrapRequestSchema = z.object({
  version: z.literal(NATIVE_CONTRACT_VERSION),
  requestId: requestIdSchema,
  installationId: uuidSchema,
  authorizationCode: z.string().min(32).max(4096).regex(/^\S+$/),
  codeVerifier: z.string().min(43).max(128).regex(/^[A-Za-z0-9._~-]+$/),
  redirectUri: z.literal('mc://auth/callback'),
  appVersion: nonBlankString(64),
  buildNumber: z.number().int().positive(),
}).strict();

const trustedOriginSchema = z.string().max(2048).regex(TRUSTED_ORIGIN_PATTERN).refine((value) => {
  try {
    normalizeNativeTrustedOrigin(value);
    return true;
  } catch {
    return false;
  }
}, 'Invalid native trusted origin');

export const nativeBootstrapResponseSchema = z.object({
  version: z.literal(NATIVE_CONTRACT_VERSION),
  requestId: requestIdSchema,
  ok: z.literal(true),
  data: z.object({
    trustedOrigin: trustedOriginSchema,
    bridgeVersion: z.literal(NATIVE_CONTRACT_VERSION),
    installationCredential: nativeInstallationCredentialSchema,
    shareExtensionCredential: nativeShareExtensionCredentialSchema.optional(),
  }).strict(),
}).strict();

export type NativeCredential = z.infer<typeof nativeCredentialSchema>;
export type NativeBootstrapRequest = z.infer<typeof nativeBootstrapRequestSchema>;
export type NativeBootstrapResponse = z.infer<typeof nativeBootstrapResponseSchema>;

const credentialLifecycleBase = {
  version: z.literal(NATIVE_CONTRACT_VERSION),
  requestId: requestIdSchema,
  installationId: uuidSchema,
};

export const nativeCredentialRotationRequestSchema = z.object({
  ...credentialLifecycleBase,
  credentialId: uuidSchema,
  credentialKind: z.enum(['installation', 'share_extension']),
}).strict();

export const nativeCredentialRotationResponseSchema = z.discriminatedUnion('credentialKind', [
  z.object({
    version: z.literal(NATIVE_CONTRACT_VERSION),
    requestId: requestIdSchema,
    ok: z.literal(true),
    credentialKind: z.literal('installation'),
    credential: nativeInstallationCredentialSchema,
  }).strict(),
  z.object({
    version: z.literal(NATIVE_CONTRACT_VERSION),
    requestId: requestIdSchema,
    ok: z.literal(true),
    credentialKind: z.literal('share_extension'),
    credential: nativeShareExtensionCredentialSchema,
  }).strict(),
]);

export const nativeCredentialRevocationRequestSchema = z.object({
  ...credentialLifecycleBase,
  credentialId: uuidSchema,
  reason: z.enum(['logout', 'rotation', 'security', 'user_requested']),
}).strict();

export const nativeLogoutRequestSchema = z.object({
  ...credentialLifecycleBase,
}).strict();

export const nativeLogoutResponseSchema = z.object({
  version: z.literal(NATIVE_CONTRACT_VERSION),
  requestId: requestIdSchema,
  ok: z.literal(true),
  data: z.object({
    credentialsRevoked: z.number().int().min(0).max(2),
    registrationsRetired: z.number().int().min(0).max(20),
  }).strict(),
}).strict();

export type NativeCredentialRotationRequest = z.infer<typeof nativeCredentialRotationRequestSchema>;
export type NativeCredentialRotationResponse = z.infer<typeof nativeCredentialRotationResponseSchema>;
export type NativeCredentialRevocationRequest = z.infer<typeof nativeCredentialRevocationRequestSchema>;
export type NativeLogoutRequest = z.infer<typeof nativeLogoutRequestSchema>;
export type NativeLogoutResponse = z.infer<typeof nativeLogoutResponseSchema>;

const bundleIdentifierSchema = z.string()
  .min(3)
  .max(255)
  .regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/);

export const apnsRegistrationRequestSchema = z.object({
  version: z.literal(NATIVE_CONTRACT_VERSION),
  requestId: requestIdSchema,
  installationId: uuidSchema,
  deviceToken: z.string().min(64).max(200).regex(/^(?:[a-fA-F0-9]{2}){32,100}$/),
  environment: z.enum(['development', 'production']),
  topic: bundleIdentifierSchema,
  appVersion: nonBlankString(64),
  buildNumber: z.number().int().positive(),
  locale: nonBlankString(35, 2),
  timeZone: nonBlankString(100),
}).strict();

export const apnsRegistrationResponseSchema = z.object({
  version: z.literal(NATIVE_CONTRACT_VERSION),
  requestId: requestIdSchema,
  ok: z.literal(true),
  data: z.object({
    registrationId: uuidSchema,
    state: z.enum(['registered', 'rotated']),
    updatedAt: isoDateSchema,
  }).strict(),
}).strict();

export const apnsUnregistrationRequestSchema = z.object({
  version: z.literal(NATIVE_CONTRACT_VERSION),
  requestId: requestIdSchema,
  installationId: uuidSchema,
  registrationId: uuidSchema,
}).strict();

export type ApnsRegistrationRequest = z.infer<typeof apnsRegistrationRequestSchema>;
export type ApnsRegistrationResponse = z.infer<typeof apnsRegistrationResponseSchema>;
export type ApnsUnregistrationRequest = z.infer<typeof apnsUnregistrationRequestSchema>;

const shareCaptureBase = {
  version: z.literal(NATIVE_CONTRACT_VERSION),
  requestId: requestIdSchema,
  client: z.literal('ios'),
  capturedAt: isoDateSchema.optional(),
};

export const shareSheetCaptureRequestSchema = z.discriminatedUnion('contentType', [
  z.object({
    ...shareCaptureBase,
    contentType: z.literal('url'),
    url: httpUrlSchema,
    title: nonBlankString(500).optional(),
    sharedText: nonBlankString(100_000).optional(),
  }).strict(),
  z.object({
    ...shareCaptureBase,
    contentType: z.literal('text'),
    text: nonBlankString(100_000),
    title: nonBlankString(500).optional(),
  }).strict(),
]);

export const nativeApiErrorEnvelopeSchema = z.object({
  version: z.literal(NATIVE_CONTRACT_VERSION),
  requestId: requestIdSchema,
  ok: z.literal(false),
  error: z.object({
    code: z.enum([
      'INVALID_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'TOKEN_EXPIRED',
      'REPLAY_DETECTED',
      'RATE_LIMITED',
      'IMAGE_CAPTURE_UNAVAILABLE',
      'INTERNAL_ERROR',
    ]),
    message: nonBlankString(512),
    retryable: z.boolean(),
  }).strict(),
}).strict();

export const shareSheetCaptureResponseSchema = z.object({
  version: z.literal(NATIVE_CONTRACT_VERSION),
  requestId: requestIdSchema,
  ok: z.literal(true),
  data: z.object({
    itemId: nonBlankString(128),
    status: z.enum(['created', 'duplicate']),
  }).strict(),
}).strict();

export type ShareSheetCaptureRequest = z.infer<typeof shareSheetCaptureRequestSchema>;
export type ShareSheetCaptureResponse = z.infer<typeof shareSheetCaptureResponseSchema>;
export type NativeApiErrorEnvelope = z.infer<typeof nativeApiErrorEnvelopeSchema>;

function closeJsonSchemaTuples(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(closeJsonSchemaTuples);
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }

  const node = value as Record<string, unknown>;
  if (Array.isArray(node.prefixItems)) {
    node.minItems = node.prefixItems.length;
    node.maxItems = node.prefixItems.length;
    node.items = false;
  }
  Object.values(node).forEach(closeJsonSchemaTuples);
}

function toSharedJsonSchema(schema: z.ZodType) {
  const jsonSchema = z.toJSONSchema(schema);
  closeJsonSchemaTuples(jsonSchema);
  return jsonSchema;
}

export function getNativeContractJsonSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://missioncontrol.example/contracts/mobile-ios-native-v1.schema.json',
    title: 'Mission Control iOS Native Contract v1',
    contractVersion: NATIVE_CONTRACT_VERSION,
    bridgeMaxMessageBytes: NATIVE_BRIDGE_MAX_MESSAGE_BYTES,
    imageCaptureDependencyIssue: SHARE_IMAGE_DEPENDENCY_ISSUE,
    $defs: {
      NativeBridgeRequest: toSharedJsonSchema(nativeBridgeRequestSchema),
      NativeBridgeEvent: toSharedJsonSchema(nativeBridgeEventSchema),
      NativeBridgeResponse: toSharedJsonSchema(nativeBridgeResponseSchema),
      NativeInstallationCredential: toSharedJsonSchema(nativeInstallationCredentialSchema),
      NativeShareExtensionCredential: toSharedJsonSchema(nativeShareExtensionCredentialSchema),
      NativeCredential: toSharedJsonSchema(nativeCredentialSchema),
      NativeBootstrapRequest: toSharedJsonSchema(nativeBootstrapRequestSchema),
      NativeBootstrapResponse: toSharedJsonSchema(nativeBootstrapResponseSchema),
      NativeCredentialRotationRequest: toSharedJsonSchema(nativeCredentialRotationRequestSchema),
      NativeCredentialRotationResponse: toSharedJsonSchema(nativeCredentialRotationResponseSchema),
      NativeCredentialRevocationRequest: toSharedJsonSchema(nativeCredentialRevocationRequestSchema),
      NativeLogoutRequest: toSharedJsonSchema(nativeLogoutRequestSchema),
      NativeLogoutResponse: toSharedJsonSchema(nativeLogoutResponseSchema),
      ApnsRegistrationRequest: toSharedJsonSchema(apnsRegistrationRequestSchema),
      ApnsRegistrationResponse: toSharedJsonSchema(apnsRegistrationResponseSchema),
      ApnsUnregistrationRequest: toSharedJsonSchema(apnsUnregistrationRequestSchema),
      ShareSheetCaptureRequest: toSharedJsonSchema(shareSheetCaptureRequestSchema),
      ShareSheetCaptureResponse: toSharedJsonSchema(shareSheetCaptureResponseSchema),
      NativeApiErrorEnvelope: toSharedJsonSchema(nativeApiErrorEnvelopeSchema),
    },
  };
}
