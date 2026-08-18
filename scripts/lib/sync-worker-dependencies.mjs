export const syncWorkerExternalPackages = [
  '@metascraper/*',
  'better-sqlite3',
  'metascraper',
  'metascraper-*',
  'node-cron',
  'pino',
  'pino-pretty',
  're2',
];

export const syncWorkerSupplementalPackages = ['pino-pretty'];

export const syncWorkerRequiredArtifacts = [
  'node_modules/better-sqlite3/package.json',
  'node_modules/metascraper/package.json',
  'node_modules/metascraper-author/package.json',
  'node_modules/metascraper-description/package.json',
  'node_modules/metascraper-iframe/package.json',
  'node_modules/metascraper-image/package.json',
  'node_modules/metascraper-logo/package.json',
  'node_modules/metascraper-publisher/package.json',
  'node_modules/metascraper-title/package.json',
  'node_modules/metascraper-url/package.json',
  'node_modules/metascraper-video/package.json',
  'node_modules/node-cron/package.json',
  'node_modules/node-cron/dist/tasks/background-scheduled-task/daemon.cjs',
  'node_modules/pino/package.json',
  'node_modules/pino-pretty/package.json',
  'node_modules/re2/package.json',
];

export const syncWorkerRequiredNativeArtifacts = [
  /node_modules\/better-sqlite3\/.*better_sqlite3\.node$/,
  /node_modules\/re2\/.*re2\.node$/,
];
