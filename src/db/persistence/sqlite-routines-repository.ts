import type Database from 'better-sqlite3';
import type { PersistenceJson } from './contracts';
import type {
  CreateRoutineCompletionResult,
  RoutineCompletionQuery,
  RoutineCompletionRecord,
  RoutineRecord,
  RoutinesRepository,
  RoutineUpdate,
} from './routines';

interface SqliteRoutineRow extends Omit<
  RoutineRecord,
  'cadenceConfig' | 'isActive' | 'isArchived'
> {
  cadenceConfig: string;
  isActive: number;
  isArchived: number;
}

const ROUTINE_COLUMNS = `
  id, name, description, cadence_type AS cadenceType,
  cadence_config AS cadenceConfig, icon, sort_order AS sortOrder,
  is_active AS isActive, is_archived AS isArchived,
  created_at AS createdAt, updated_at AS updatedAt
`;

const COMPLETION_COLUMNS = `
  id, routine_id AS routineId, date, notes, completed_at AS completedAt
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

function routineFromRow(row: SqliteRoutineRow): RoutineRecord {
  return {
    ...row,
    cadenceConfig: JSON.parse(row.cadenceConfig) as PersistenceJson,
    isActive: row.isActive !== 0,
    isArchived: row.isArchived !== 0,
  };
}

function sqliteValue(field: keyof RoutineUpdate, value: unknown): unknown {
  if (field === 'cadenceConfig') return JSON.stringify(value);
  if ((field === 'isActive' || field === 'isArchived') && typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return value;
}

function completionOrder(order: RoutineCompletionQuery['order']): string {
  if (order === 'ascending') return ' ORDER BY date COLLATE BINARY ASC';
  if (order === 'descending') return ' ORDER BY date COLLATE BINARY DESC';
  return '';
}

export function createSqliteRoutinesRepository(
  sqlite: Database.Database,
): RoutinesRepository {
  return {
    async listRoutines(includeArchived) {
      const rows = sqlite.prepare(`
        SELECT ${ROUTINE_COLUMNS}
        FROM routines
        ${includeArchived ? '' : 'WHERE is_archived = 0'}
        ORDER BY sort_order ASC, created_at COLLATE BINARY ASC
      `).all() as SqliteRoutineRow[];
      return rows.map(routineFromRow);
    },

    async getRoutine(id) {
      const row = sqlite.prepare(`
        SELECT ${ROUTINE_COLUMNS} FROM routines WHERE id = ?
      `).get(id) as SqliteRoutineRow | undefined;
      return row ? routineFromRow(row) : null;
    },

    async createRoutine(command) {
      sqlite.transaction(() => {
        const max = sqlite.prepare(
          'SELECT sort_order AS sortOrder FROM routines ORDER BY sort_order DESC LIMIT 1',
        ).get() as { sortOrder: number | null } | undefined;
        const sortOrder = max ? (max.sortOrder ?? 0) + 1 : 0;
        sqlite.prepare(`
          INSERT INTO routines (
            id, name, description, cadence_type, cadence_config, icon, sort_order,
            is_active, is_archived, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
        `).run(
          command.id,
          command.name,
          command.description,
          command.cadenceType,
          JSON.stringify(command.cadenceConfig),
          command.icon,
          sortOrder,
          command.createdAt,
          command.updatedAt,
        );
      }).immediate();
    },

    async updateRoutine(id, { updates, updatedAt }) {
      const fields = Object.keys(updates) as Array<keyof RoutineUpdate>;
      const assignments = [
        ...fields.map((field) => `${UPDATE_COLUMNS[field]} = ?`),
        'updated_at = ?',
      ].join(', ');
      const result = sqlite.prepare(`
        UPDATE routines SET ${assignments} WHERE id = ?
      `).run(
        ...fields.map((field) => sqliteValue(field, updates[field])),
        updatedAt,
        id,
      );
      return result.changes > 0;
    },

    async archiveRoutine(id, updatedAt) {
      const result = sqlite.prepare(`
        UPDATE routines
        SET is_archived = 1, is_active = 0, updated_at = ?
        WHERE id = ?
      `).run(updatedAt, id);
      return result.changes > 0;
    },

    async listCompletions(query) {
      const conditions = ['date >= ?'];
      const values: string[] = [query.fromInclusive];
      if (query.toInclusive !== undefined) {
        conditions.push('date <= ?');
        values.push(query.toInclusive);
      }
      if (query.routineId !== undefined) {
        conditions.push('routine_id = ?');
        values.push(query.routineId);
      }
      return sqlite.prepare(`
        SELECT ${COMPLETION_COLUMNS}
        FROM routine_completions
        WHERE ${conditions.join(' AND ')}
        ${completionOrder(query.order)}
      `).all(...values) as RoutineCompletionRecord[];
    },

    async createCompletion(command): Promise<CreateRoutineCompletionResult> {
      return sqlite.transaction(() => {
        const routine = sqlite.prepare(
          'SELECT cadence_type AS cadenceType FROM routines WHERE id = ?',
        ).get(command.routineId) as { cadenceType: string } | undefined;
        if (!routine) return { outcome: 'routine-not-found' };

        if (routine.cadenceType === 'daily' || routine.cadenceType === 'specific_days') {
          const existing = sqlite.prepare(`
            SELECT 1 FROM routine_completions
            WHERE routine_id = ? AND date = ?
            LIMIT 1
          `).get(command.routineId, command.date);
          if (existing) return { outcome: 'duplicate' };
        }

        sqlite.prepare(`
          INSERT INTO routine_completions (id, routine_id, date, notes, completed_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          command.id,
          command.routineId,
          command.date,
          command.notes,
          command.completedAt,
        );
        return { outcome: 'created' };
      }).immediate();
    },

    async deleteCompletionById(id) {
      sqlite.prepare('DELETE FROM routine_completions WHERE id = ?').run(id);
    },

    async deleteCompletionsForDate(routineId, date) {
      sqlite.prepare(`
        DELETE FROM routine_completions WHERE routine_id = ? AND date = ?
      `).run(routineId, date);
    },
  };
}
