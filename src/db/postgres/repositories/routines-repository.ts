import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  CreateRoutineCompletionResult,
  RoutineCompletionQuery,
  RoutineCompletionRecord,
  RoutineRecord,
  RoutinesRepository,
  RoutineUpdate,
} from '@/db/persistence/routines';

const ROUTINE_SORT_LOCK = 'routines:sort-order';

const ROUTINE_COLUMNS = `
  id, name, description, cadence_type AS "cadenceType",
  cadence_config AS "cadenceConfig", icon, sort_order AS "sortOrder",
  is_active AS "isActive", is_archived AS "isArchived",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const COMPLETION_COLUMNS = `
  id, routine_id AS "routineId", date, notes, completed_at AS "completedAt"
`;

const UPDATE_COLUMNS: Record<keyof RoutineUpdate, string> = {
  name: 'name',
  cadenceType: 'cadence_type',
  cadenceConfig: 'cadence_config',
  description: 'description',
  icon: 'icon',
  isActive: 'is_active',
  isArchived: 'is_archived',
  sortOrder: 'sort_order',
};

async function query<T extends QueryResultRow>(
  client: Pool | PoolClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(text, [...values])).rows;
}

async function withMutationTransaction<T>(
  pool: Pool,
  lockKeys: readonly string[],
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const keys = [...new Set(lockKeys)].sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      for (const key of keys) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      }
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

function completionOrder(order: RoutineCompletionQuery['order']): string {
  if (order === 'ascending') return ' ORDER BY date COLLATE "C" ASC';
  if (order === 'descending') return ' ORDER BY date COLLATE "C" DESC';
  return '';
}

export function createPostgresRoutinesRepository(pool: Pool): RoutinesRepository {
  return {
    async listRoutines(includeArchived) {
      return query<RoutineRecord>(pool, `
        SELECT ${ROUTINE_COLUMNS}
        FROM routines
        ${includeArchived ? '' : 'WHERE is_archived = FALSE'}
        ORDER BY sort_order ASC, created_at COLLATE "C" ASC
      `);
    },

    async getRoutine(id) {
      const [routine] = await query<RoutineRecord>(
        pool,
        `SELECT ${ROUTINE_COLUMNS} FROM routines WHERE id = $1`,
        [id],
      );
      return routine ?? null;
    },

    async createRoutine(command) {
      await withMutationTransaction(pool, [ROUTINE_SORT_LOCK], async (client) => {
        const [max] = await query<{ sortOrder: number | null }>(client, `
          SELECT sort_order AS "sortOrder"
          FROM routines
          ORDER BY sort_order DESC
          LIMIT 1
        `);
        const sortOrder = max ? (max.sortOrder ?? 0) + 1 : 0;
        await client.query(`
          INSERT INTO routines (
            id, name, description, cadence_type, cadence_config, icon, sort_order,
            is_active, is_archived, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, TRUE, FALSE, $8, $9)
        `, [
          command.id,
          command.name,
          command.description,
          command.cadenceType,
          JSON.stringify(command.cadenceConfig),
          command.icon,
          sortOrder,
          command.createdAt,
          command.updatedAt,
        ]);
      });
    },

    async updateRoutine(id, { updates, updatedAt }) {
      const fields = Object.keys(updates) as Array<keyof RoutineUpdate>;
      const assignments = [
        ...fields.map((field, index) => (
          `${UPDATE_COLUMNS[field]} = $${index + 1}${
            field === 'cadenceConfig' ? '::jsonb' : ''
          }`
        )),
        `updated_at = $${fields.length + 1}`,
      ].join(', ');
      const values = fields.map((field) => (
        field === 'cadenceConfig' ? JSON.stringify(updates[field]) : updates[field]
      ));
      const result = await pool.query(
        `UPDATE routines SET ${assignments} WHERE id = $${fields.length + 2}`,
        [...values, updatedAt, id],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async archiveRoutine(id, updatedAt) {
      const result = await pool.query(`
        UPDATE routines
        SET is_archived = TRUE, is_active = FALSE, updated_at = $1
        WHERE id = $2
      `, [updatedAt, id]);
      return (result.rowCount ?? 0) > 0;
    },

    async listCompletions(completionQuery) {
      const conditions = ['date >= $1'];
      const values: string[] = [completionQuery.fromInclusive];
      if (completionQuery.toInclusive !== undefined) {
        values.push(completionQuery.toInclusive);
        conditions.push(`date <= $${values.length}`);
      }
      if (completionQuery.routineId !== undefined) {
        values.push(completionQuery.routineId);
        conditions.push(`routine_id = $${values.length}`);
      }
      return query<RoutineCompletionRecord>(pool, `
        SELECT ${COMPLETION_COLUMNS}
        FROM routine_completions
        WHERE ${conditions.join(' AND ')}
        ${completionOrder(completionQuery.order)}
      `, values);
    },

    async createCompletion(command): Promise<CreateRoutineCompletionResult> {
      const lockKey = `routine-completion:${command.routineId}:${command.date}`;
      return withMutationTransaction(pool, [lockKey], async (client) => {
        const [routine] = await query<{ cadenceType: string }>(client, `
          SELECT cadence_type AS "cadenceType" FROM routines WHERE id = $1
        `, [command.routineId]);
        if (!routine) return { outcome: 'routine-not-found' };

        if (routine.cadenceType === 'daily' || routine.cadenceType === 'specific_days') {
          const existing = await query(client, `
            SELECT 1 FROM routine_completions
            WHERE routine_id = $1 AND date = $2
            LIMIT 1
          `, [command.routineId, command.date]);
          if (existing.length > 0) return { outcome: 'duplicate' };
        }

        await client.query(`
          INSERT INTO routine_completions (id, routine_id, date, notes, completed_at)
          VALUES ($1, $2, $3, $4, $5)
        `, [
          command.id,
          command.routineId,
          command.date,
          command.notes,
          command.completedAt,
        ]);
        return { outcome: 'created' };
      });
    },

    async deleteCompletionById(id) {
      await pool.query('DELETE FROM routine_completions WHERE id = $1', [id]);
    },

    async deleteCompletionsForDate(routineId, date) {
      await pool.query(
        'DELETE FROM routine_completions WHERE routine_id = $1 AND date = $2',
        [routineId, date],
      );
    },
  };
}
