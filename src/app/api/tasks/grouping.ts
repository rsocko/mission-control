import { sql, type SQL } from 'drizzle-orm';
import { tasks } from '@/db/schema';

export function getTaskListGroupExpression(): SQL<string> {
  return sql<string>`COALESCE(
    NULLIF((
      SELECT COALESCE(NULLIF(sl.user_display_name, ''), NULLIF(sl.name, ''))
      FROM source_lists sl
      WHERE sl.connector_instance_id = ${tasks.connectorInstanceId}
        AND sl.source_id = ${tasks.sourceListId}
      LIMIT 1
    ), ''),
    NULLIF(${tasks.sourceListName}, ''),
    'No List'
  )`;
}
