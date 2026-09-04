interface ProcessRuntimeSlot<T> {
  schemaVersion: number;
  value: T;
}

export function getProcessRuntimeSlot<T>(
  key: string,
  schemaVersion: number,
  initialize: () => T,
): T {
  const symbol = Symbol.for(key);
  const host = globalThis as typeof globalThis & { [slot: symbol]: unknown };
  const existing = host[symbol];

  if (existing === undefined) {
    const slot: ProcessRuntimeSlot<T> = {
      schemaVersion,
      value: initialize(),
    };
    host[symbol] = slot;
    return slot.value;
  }

  if (
    typeof existing !== 'object'
    || existing === null
    || !('schemaVersion' in existing)
    || existing.schemaVersion !== schemaVersion
    || !('value' in existing)
  ) {
    throw new Error(`Incompatible process runtime slot: ${key}`);
  }

  return existing.value as T;
}
