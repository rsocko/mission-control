import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub notification category migration', () => {
  it('moves every existing GitHub subtype into Development without changing other sources', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE notifications (
          id TEXT PRIMARY KEY,
          connector_type TEXT NOT NULL,
          category TEXT NOT NULL
        );
        INSERT INTO notifications VALUES
          ('github-social', 'github-issues', 'social'),
          ('github-security', 'github-issues', 'security'),
          ('github-review', 'github-issues', 'pr_review'),
          ('message-social', 'rymessage', 'social');
      `);
      sqlite.exec(readFileSync(
        resolve(process.cwd(), 'drizzle/0107_github_notification_category.sql'),
        'utf8',
      ));

      expect(sqlite.prepare(`
        SELECT id, category FROM notifications ORDER BY id
      `).all()).toEqual([
        { id: 'github-review', category: 'development' },
        { id: 'github-security', category: 'development' },
        { id: 'github-social', category: 'development' },
        { id: 'message-social', category: 'social' },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
