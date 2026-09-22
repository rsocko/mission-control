export type DatabaseTargetSafetyIssue =
  | 'invalid-url'
  | 'invalid-protocol'
  | 'invalid-database-name'
  | 'production-looking'
  | 'missing-non-production-marker';

export type DatabaseTargetSafetyAssessment =
  | { safe: true; protocol: string; host: string; database: string }
  | {
      safe: false;
      issue: DatabaseTargetSafetyIssue;
      protocol?: string;
      host?: string;
      database?: string;
    };

function looksLikeProduction(host: string, database: string): boolean {
  const needle = /prod(uction)?/i;
  return needle.test(host) || needle.test(database);
}

function hasNonProductionMarker(database: string): boolean {
  const needle = /(?:^|[-_.])(test|tests|testing|ci|dev|sandbox|local)(?:[-_.]|$)/i;
  return needle.test(database);
}

/**
 * Classifies a database URL without consulting environment variables or
 * applying any runtime composition policy. Host locality alone never proves a
 * target is non-production.
 */
export function assessNonProductionDatabaseTarget(
  connectionString: string,
  allowedProtocols: readonly string[],
): DatabaseTargetSafetyAssessment {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { safe: false, issue: 'invalid-url' };
  }

  if (!allowedProtocols.includes(url.protocol)) {
    return { safe: false, issue: 'invalid-protocol', protocol: url.protocol };
  }

  const host = url.hostname;
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return { safe: false, issue: 'invalid-database-name', protocol: url.protocol, host };
  }

  if (looksLikeProduction(host, database)) {
    return {
      safe: false,
      issue: 'production-looking',
      protocol: url.protocol,
      host,
      database,
    };
  }
  if (!hasNonProductionMarker(database)) {
    return {
      safe: false,
      issue: 'missing-non-production-marker',
      protocol: url.protocol,
      host,
      database,
    };
  }
  return { safe: true, protocol: url.protocol, host, database };
}

export function assertNonProductionDatabaseTarget(
  connectionString: string,
  allowedProtocols: readonly string[],
): void {
  const assessment = assessNonProductionDatabaseTarget(connectionString, allowedProtocols);
  if (assessment.safe) return;
  throw new Error(`Unsafe database target: ${assessment.issue}`);
}
