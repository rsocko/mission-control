import 'server-only';

export type ApnsEnvironment = 'development' | 'production';

export interface ApnsConfiguration {
  teamId: string;
  keyId: string;
  privateKey: string;
  topic: string;
  environment: ApnsEnvironment;
  tokenEncryptionKey: Buffer;
}

function requirePattern(name: string, value: string | undefined, pattern: RegExp): string {
  if (!value || !pattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

export function getApnsConfiguration(): ApnsConfiguration {
  const teamId = requirePattern('APNS_TEAM_ID', process.env.APNS_TEAM_ID, /^[A-Z0-9]{10}$/);
  const keyId = requirePattern('APNS_KEY_ID', process.env.APNS_KEY_ID, /^[A-Z0-9]{10}$/);
  const topic = requirePattern(
    'APNS_TOPIC',
    process.env.APNS_TOPIC,
    /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/,
  );
  const environment = process.env.APNS_ENVIRONMENT;
  if (environment !== 'development' && environment !== 'production') {
    throw new Error('APNS_ENVIRONMENT must be development or production');
  }

  const privateKeyBase64 = process.env.APNS_PRIVATE_KEY_P8_BASE64;
  if (!privateKeyBase64) throw new Error('APNS_PRIVATE_KEY_P8_BASE64 is missing');
  const privateKey = Buffer.from(privateKeyBase64, 'base64').toString('utf8');
  if (!/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\s*$/.test(privateKey)) {
    throw new Error('APNS_PRIVATE_KEY_P8_BASE64 does not contain a PKCS#8 private key');
  }

  const encryptionKeyBase64 = process.env.APNS_TOKEN_ENCRYPTION_KEY;
  if (!encryptionKeyBase64) throw new Error('APNS_TOKEN_ENCRYPTION_KEY is missing');
  const tokenEncryptionKey = Buffer.from(encryptionKeyBase64, 'base64');
  if (tokenEncryptionKey.length !== 32) {
    throw new Error('APNS_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }

  return {
    teamId,
    keyId,
    privateKey,
    topic,
    environment,
    tokenEncryptionKey,
  };
}

export function isApnsConfigured(): boolean {
  try {
    getApnsConfiguration();
    return true;
  } catch {
    return false;
  }
}

export function apnsEndpoint(environment: ApnsEnvironment): string {
  return environment === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
}
