import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/dom';
import { vi } from 'vitest';

// Sharded DOM tests can be delayed by runner contention even when the test
// itself remains within the project's 10-second timeout.
configure({ asyncUtilTimeout: 5_000 });

type MockSqlExpression = {
  type: string;
  args?: unknown[];
  col?: unknown;
  val?: unknown;
  vals?: unknown;
};

// Mock drizzle-orm operators
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]): MockSqlExpression => ({ type: 'eq', args })),
  and: vi.fn((...args: unknown[]): MockSqlExpression => ({ type: 'and', args })),
  or: vi.fn((...args: unknown[]): MockSqlExpression => ({ type: 'or', args })),
  desc: vi.fn((col: unknown): MockSqlExpression => ({ type: 'desc', col })),
  asc: vi.fn((col: unknown): MockSqlExpression => ({ type: 'asc', col })),
  isNull: vi.fn((col: unknown): MockSqlExpression => ({ type: 'isNull', col })),
  isNotNull: vi.fn((col: unknown): MockSqlExpression => ({ type: 'isNotNull', col })),
  inArray: vi.fn((col: unknown, vals: unknown): MockSqlExpression => ({ type: 'inArray', col, vals })),
  notInArray: vi.fn((col: unknown, vals: unknown): MockSqlExpression => ({ type: 'notInArray', col, vals })),
  lt: vi.fn((col: unknown, val: unknown): MockSqlExpression => ({ type: 'lt', col, val })),
  lte: vi.fn((col: unknown, val: unknown): MockSqlExpression => ({ type: 'lte', col, val })),
  gt: vi.fn((col: unknown, val: unknown): MockSqlExpression => ({ type: 'gt', col, val })),
  gte: vi.fn((col: unknown, val: unknown): MockSqlExpression => ({ type: 'gte', col, val })),
  ne: vi.fn((col: unknown, val: unknown): MockSqlExpression => ({ type: 'ne', col, val })),
  not: vi.fn((col: unknown): MockSqlExpression => ({ type: 'not', col })),
  sql: vi.fn(() => ({ as: vi.fn(() => ({})) })),
  like: vi.fn((col: unknown, val: unknown): MockSqlExpression => ({ type: 'like', col, val })),
  notLike: vi.fn((col: unknown, val: unknown): MockSqlExpression => ({ type: 'notLike', col, val })),
}));
