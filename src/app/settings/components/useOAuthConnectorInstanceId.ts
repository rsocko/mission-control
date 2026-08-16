'use client';

import { useCallback, useRef } from 'react';

export type RandomUuid = () => string;

function secureRandomUuid() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Secure UUID generation is unavailable');
  }
  return globalThis.crypto.randomUUID();
}

export function createOAuthConnectorInstanceId(
  prefix: string,
  randomUuid: RandomUuid = secureRandomUuid,
) {
  return `${prefix}-${randomUuid()}`;
}

export function useOAuthConnectorInstanceId(
  prefix: string,
  randomUuid: RandomUuid = secureRandomUuid,
) {
  const instanceRef = useRef<{ prefix: string; id: string } | null>(null);
  return useCallback(() => {
    if (!instanceRef.current || instanceRef.current.prefix !== prefix) {
      instanceRef.current = {
        prefix,
        id: createOAuthConnectorInstanceId(prefix, randomUuid),
      };
    }
    return instanceRef.current.id;
  }, [prefix, randomUuid]);
}
