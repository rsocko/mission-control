import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

export interface EncryptedProviderSessionReference {
  encryptedReference: string;
  initializationVector: string;
  authTag: string;
  keyVersion: string;
}

function decodeKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error(
      'MC_AI_PROVIDER_SESSION_KEY must be a 32-byte base64 or 64-character hex key.',
    );
  }
  return key;
}

export class ProviderSessionProtector {
  private readonly key: Buffer;

  constructor(
    key: string,
    readonly keyVersion = 'v1',
  ) {
    this.key = decodeKey(key);
  }

  static fromEnvironment(): ProviderSessionProtector {
    const key = process.env.MC_AI_PROVIDER_SESSION_KEY;
    if (!key) {
      throw new Error(
        'MC_AI_PROVIDER_SESSION_KEY is required before provider session references can be stored.',
      );
    }
    return new ProviderSessionProtector(
      key,
      process.env.MC_AI_PROVIDER_SESSION_KEY_VERSION?.trim() || 'v1',
    );
  }

  encrypt(
    runId: string,
    provider: string,
    reference: string,
  ): EncryptedProviderSessionReference {
    const initializationVector = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, initializationVector);
    cipher.setAAD(Buffer.from(`${runId}\0${provider}\0${this.keyVersion}`));
    const encrypted = Buffer.concat([
      cipher.update(reference, 'utf8'),
      cipher.final(),
    ]);
    return {
      encryptedReference: encrypted.toString('base64'),
      initializationVector: initializationVector.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: this.keyVersion,
    };
  }

  decrypt(
    runId: string,
    provider: string,
    value: EncryptedProviderSessionReference,
  ): string {
    if (value.keyVersion !== this.keyVersion) {
      throw new Error(
        `Provider session key version ${value.keyVersion} is not available.`,
      );
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(value.initializationVector, 'base64'),
    );
    decipher.setAAD(Buffer.from(`${runId}\0${provider}\0${value.keyVersion}`));
    decipher.setAuthTag(Buffer.from(value.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.encryptedReference, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
