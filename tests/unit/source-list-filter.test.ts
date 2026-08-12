import { getSourceListIdsCondition } from '@/app/api/tasks/filter-query';

interface MockSqlExpression {
  type: string;
  args: Array<MockSqlExpression | string>;
}

describe('source list ID filtering', () => {
  it('matches both exact colon-bearing IDs and connector-qualified IDs', () => {
    const condition = getSourceListIdsCondition([
      'scout:email-actions',
    ]) as unknown as MockSqlExpression;
    const valueCondition = condition.args[0] as MockSqlExpression;
    const exactCondition = valueCondition.args[0] as MockSqlExpression;
    const qualifiedCondition = valueCondition.args[1] as MockSqlExpression;
    const connectorCondition = qualifiedCondition.args[0] as MockSqlExpression;
    const listCondition = qualifiedCondition.args[1] as MockSqlExpression;

    expect(exactCondition.type).toBe('eq');
    expect(exactCondition.args[1]).toBe('scout:email-actions');
    expect(qualifiedCondition.type).toBe('and');
    expect(connectorCondition.args[1]).toBe('scout');
    expect(listCondition.args[1]).toBe('email-actions');
  });

  it('keeps colon-free list IDs as exact matches', () => {
    const condition = getSourceListIdsCondition([
      'backlog',
    ]) as unknown as MockSqlExpression;
    const exactCondition = condition.args[0] as MockSqlExpression;

    expect(exactCondition.type).toBe('eq');
    expect(exactCondition.args[1]).toBe('backlog');
  });
});
