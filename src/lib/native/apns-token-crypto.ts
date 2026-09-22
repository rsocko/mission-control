import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { getApnsConfiguration } from '@/lib/push/apns-config';

export function hashApnsDeviceToken(deviceToken: string): string {
  return createHash('sha256').update(deviceToken.toLowerCase(), 'ascii').digest('hex');
}

export function encryptApnsDeviceToken(deviceToken: string): string {
  const { tokenEncryptionKey } = getApnsConfiguration();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenEncryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(deviceToken.toLowerCase(), 'ascii'),
    cipher.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

export function decryptApnsDeviceToken(value: string): string {
  const [version, ivValue, ciphertextValue, tagValue, ...extra] = value.split('.');
  if (version !== 'v1' || !ivValue || !ciphertextValue || !tagValue || extra.length > 0) {
    throw new Error('Stored APNs token is invalid');
  }
  const { tokenEncryptionKey } = getApnsConfiguration();
  const decipher = createDecipheriv(
    'aes-256-gcm',
    tokenEncryptionKey,
    Buffer.from(ivValue, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('ascii');
}
