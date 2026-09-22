import { and, asc, desc, eq, gt, inArray, isNull, lt, lte } from 'drizzle-orm';
import { houstonConversationMemories } from '@/db/postgres/schema';
import type { PostgresDatabase } from '../runtime';
import type {
  HoustonConversationMemory,
  HoustonConversationMemoryWrite,
  HoustonMemoryListRequest,
  HoustonMemoryRepository,
} from '@/lib/houston-memory/contracts';

export class PostgresHoustonMemoryRepository implements HoustonMemoryRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async get(id: string, authorizationScope: string): Promise<HoustonConversationMemory | null> {
    const [row] = await this.db.select()
      .from(houstonConversationMemories)
      .where(and(
        eq(houstonConversationMemories.id, id),
        eq(houstonConversationMemories.authorizationScope, authorizationScope),
      ))
      .limit(1);
    return row ?? null;
  }

  async list(input: HoustonMemoryListRequest): Promise<HoustonConversationMemory[]> {
    const limit = Math.max(1, Math.min(Math.trunc(input.limit), 100));
    return this.db.select()
      .from(houstonConversationMemories)
      .where(and(
        eq(houstonConversationMemories.authorizationScope, input.authorizationScope),
        isNull(houstonConversationMemories.excludedAt),
        gt(houstonConversationMemories.retainUntil, input.now),
        lt(
          houstonConversationMemories.updatedAt,
          input.beforeUpdatedAt ?? '9999-12-31T23:59:59.999Z',
        ),
      ))
      .orderBy(desc(houstonConversationMemories.updatedAt), asc(houstonConversationMemories.id))
      .limit(limit);
  }

  async upsert(input: HoustonConversationMemoryWrite): Promise<HoustonConversationMemory> {
    await this.db.insert(houstonConversationMemories)
      .values({
        id: input.id,
        authorizationScope: input.authorizationScope,
        title: input.title,
        summary: input.summary,
        decisions: input.decisions,
        commitments: input.commitments,
        topics: input.topics,
        linkedEntities: input.linkedEntities,
        sensitivity: input.sensitivity,
        retainUntil: input.retainUntil,
        excludedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: houstonConversationMemories.id,
        set: {
          title: input.title,
          summary: input.summary,
          decisions: input.decisions,
          commitments: input.commitments,
          topics: input.topics,
          linkedEntities: input.linkedEntities,
          sensitivity: input.sensitivity,
          retainUntil: input.retainUntil,
          updatedAt: input.now,
        },
        setWhere: and(
          eq(houstonConversationMemories.authorizationScope, input.authorizationScope),
          isNull(houstonConversationMemories.excludedAt),
        ),
      });
    const stored = await this.get(input.id, input.authorizationScope);
    if (!stored) throw new Error('Houston memory could not be persisted');
    return stored;
  }

  async exclude(id: string, authorizationScope: string, now: string): Promise<boolean> {
    const rows = await this.db.update(houstonConversationMemories)
      .set({ excludedAt: now, updatedAt: now })
      .where(and(
        eq(houstonConversationMemories.id, id),
        eq(houstonConversationMemories.authorizationScope, authorizationScope),
        isNull(houstonConversationMemories.excludedAt),
      ))
      .returning({ id: houstonConversationMemories.id });
    return rows.length === 1;
  }

  async delete(id: string, authorizationScope: string): Promise<boolean> {
    const now = new Date().toISOString();
    const rows = await this.db.update(houstonConversationMemories)
      .set({
        title: '',
        summary: '',
        decisions: [],
        commitments: [],
        topics: [],
        linkedEntities: [],
        excludedAt: now,
        retainUntil: '9999-12-31T23:59:59.999Z',
        updatedAt: now,
      })
      .where(and(
        eq(houstonConversationMemories.id, id),
        eq(houstonConversationMemories.authorizationScope, authorizationScope),
      ))
      .returning({ id: houstonConversationMemories.id });
    return rows.length === 1;
  }

  async deleteExpired(now: string, limit: number): Promise<string[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    return this.db.transaction(async (tx) => {
      const rows = await tx.select({ id: houstonConversationMemories.id })
        .from(houstonConversationMemories)
        .where(lte(houstonConversationMemories.retainUntil, now))
        .orderBy(asc(houstonConversationMemories.retainUntil), asc(houstonConversationMemories.id))
        .limit(boundedLimit);
      if (rows.length === 0) return [];
      await tx.delete(houstonConversationMemories)
        .where(inArray(houstonConversationMemories.id, rows.map(({ id }) => id)));
      return rows.map(({ id }) => id);
    });
  }
}
