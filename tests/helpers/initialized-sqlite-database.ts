export async function importInitializedSqliteDatabase(): Promise<typeof import('@/db')> {
  const [database, { initializeRuntimeDatabase }] = await Promise.all([
    import('@/db'),
    import('@/db/runtime'),
  ]);
  await initializeRuntimeDatabase();
  return database;
}
