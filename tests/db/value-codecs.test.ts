import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  decodeCanonicalJsonSlot,
  decodeLenientJsonArray,
  decodeLenientJsonObject,
  decodeSqliteBoolean,
  decodeStrictJsonObject,
  encodeCanonicalJsonSlot,
  encodeSqliteBoolean,
  type CanonicalJsonSlot,
} from '@/db/persistence/value-codecs';

describe('canonicalJson', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(canonicalJson({ b: 1, a: [3, 2, { d: 1, c: 2 }] }))
      .toBe('{"a":[3,2,{"c":2,"d":1}]}');
  });

  it('round-trips primitives, null, and booleans', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(1)).toBe('1');
    expect(canonicalJson('x')).toBe('"x"');
  });

  it('treats undefined as null at the top level and omits it from objects', () => {
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('produces the same output for a re-ordered but equal double-encoded object', () => {
    const first = canonicalJson(JSON.parse('{"a":1,"b":{"x":1,"y":2}}'));
    const second = canonicalJson(JSON.parse('{"b":{"y":2,"x":1},"a":1}'));
    expect(first).toBe(second);
  });
});

describe('decodeLenientJsonObject', () => {
  it('passes through an already-decoded plain object', () => {
    expect(decodeLenientJsonObject({ a: 1 })).toEqual({ a: 1 });
  });

  it('parses a JSON-encoded object string', () => {
    expect(decodeLenientJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('falls back to {} for malformed JSON', () => {
    expect(decodeLenientJsonObject('{not json')).toEqual({});
  });

  it('falls back to {} for an empty string', () => {
    expect(decodeLenientJsonObject('')).toEqual({});
  });

  it('falls back to {} for null/undefined', () => {
    expect(decodeLenientJsonObject(null)).toEqual({});
    expect(decodeLenientJsonObject(undefined)).toEqual({});
  });

  it('falls back to {} for an array, even when JSON-encoded', () => {
    expect(decodeLenientJsonObject([1, 2])).toEqual({});
    expect(decodeLenientJsonObject('[1,2]')).toEqual({});
  });

  it('falls back to {} for a double-encoded legacy string', () => {
    // Legacy rows sometimes stored a JSON string containing JSON text rather
    // than the object itself; this codec does not recursively re-decode -
    // only a single parse pass is attempted, matching every prior call site.
    expect(decodeLenientJsonObject(JSON.stringify('{"a":1}'))).toEqual({});
  });
});

describe('decodeLenientJsonArray', () => {
  it('passes through an already-decoded array', () => {
    expect(decodeLenientJsonArray([1, 2])).toEqual([1, 2]);
  });

  it('parses a JSON-encoded array string', () => {
    expect(decodeLenientJsonArray('[1,2]')).toEqual([1, 2]);
  });

  it('falls back to [] for malformed JSON', () => {
    expect(decodeLenientJsonArray('[not json')).toEqual([]);
  });

  it('falls back to [] for an empty string', () => {
    expect(decodeLenientJsonArray('')).toEqual([]);
  });

  it('falls back to [] for null/undefined', () => {
    expect(decodeLenientJsonArray(null)).toEqual([]);
    expect(decodeLenientJsonArray(undefined)).toEqual([]);
  });

  it('falls back to [] for a JSON-encoded object', () => {
    expect(decodeLenientJsonArray('{"a":1}')).toEqual([]);
  });
});

describe('decodeStrictJsonObject', () => {
  const errors = { invalidJson: 'bad json', notAnObject: 'not an object' };

  it('passes through an already-decoded plain object', () => {
    expect(decodeStrictJsonObject({ a: 1 }, errors)).toEqual({ a: 1 });
  });

  it('parses a JSON-encoded object string', () => {
    expect(decodeStrictJsonObject('{"a":1}', errors)).toEqual({ a: 1 });
  });

  it('throws the caller-supplied message for malformed JSON', () => {
    expect(() => decodeStrictJsonObject('{not json', errors)).toThrow('bad json');
  });

  it('throws the caller-supplied message for an array', () => {
    expect(() => decodeStrictJsonObject([1, 2], errors)).toThrow('not an object');
    expect(() => decodeStrictJsonObject('[1,2]', errors)).toThrow('not an object');
  });

  it('throws the caller-supplied message for null/undefined/primitives', () => {
    expect(() => decodeStrictJsonObject(null, errors)).toThrow('not an object');
    expect(() => decodeStrictJsonObject(undefined, errors)).toThrow('not an object');
    expect(() => decodeStrictJsonObject(1, errors)).toThrow('not an object');
  });

  it('throws the caller-supplied message for a double-encoded legacy string', () => {
    expect(() => decodeStrictJsonObject(JSON.stringify('{"a":1}'), errors))
      .toThrow('not an object');
  });
});

describe('CanonicalJsonSlot encode/decode', () => {
  it('round-trips a JSON object value', () => {
    const slot: CanonicalJsonSlot = { kind: 'json-value', value: { a: 1 } };
    const raw = encodeCanonicalJsonSlot(slot);
    expect(raw).toBe('{"a":1}');
    expect(decodeCanonicalJsonSlot(raw)).toEqual(slot);
  });

  it('distinguishes SQL NULL from JSON null', () => {
    const sqlNull: CanonicalJsonSlot = { kind: 'sql-null' };
    const jsonNull: CanonicalJsonSlot = { kind: 'json-null' };

    expect(encodeCanonicalJsonSlot(sqlNull)).toBeNull();
    expect(encodeCanonicalJsonSlot(jsonNull)).toBe('null');

    expect(decodeCanonicalJsonSlot(null)).toEqual(sqlNull);
    expect(decodeCanonicalJsonSlot('null')).toEqual(jsonNull);
  });

  it('round-trips booleans, numbers, arrays, and empty-string-shaped values', () => {
    const cases: PersistenceJsonSlotCase[] = [
      { kind: 'json-value', value: true },
      { kind: 'json-value', value: false },
      { kind: 'json-value', value: 0 },
      { kind: 'json-value', value: '' },
      { kind: 'json-value', value: [] },
      { kind: 'json-value', value: {} },
    ];
    for (const slot of cases) {
      const raw = encodeCanonicalJsonSlot(slot);
      expect(decodeCanonicalJsonSlot(raw)).toEqual(slot);
    }
  });
});

type PersistenceJsonSlotCase = Extract<CanonicalJsonSlot, { kind: 'json-value' }>;

describe('SQLite boolean codec', () => {
  it('decodes 0/1 integers to false/true', () => {
    expect(decodeSqliteBoolean(0)).toBe(false);
    expect(decodeSqliteBoolean(1)).toBe(true);
  });

  it('decodes null/undefined to false', () => {
    expect(decodeSqliteBoolean(null)).toBe(false);
    expect(decodeSqliteBoolean(undefined)).toBe(false);
  });

  it('decodes bigint 0n/1n (safeIntegers mode) by truthiness', () => {
    expect(decodeSqliteBoolean(0n)).toBe(false);
    expect(decodeSqliteBoolean(1n)).toBe(true);
  });

  it('encodes booleans to 0/1', () => {
    expect(encodeSqliteBoolean(true)).toBe(1);
    expect(encodeSqliteBoolean(false)).toBe(0);
  });

  it('round-trips through encode -> decode', () => {
    expect(decodeSqliteBoolean(encodeSqliteBoolean(true))).toBe(true);
    expect(decodeSqliteBoolean(encodeSqliteBoolean(false))).toBe(false);
  });
});
