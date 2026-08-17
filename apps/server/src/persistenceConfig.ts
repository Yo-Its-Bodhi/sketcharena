import { resolve } from 'node:path';

export interface PersistenceConfiguration {
  artworkFile: string;
  progressionFile: string;
  mintFile: string;
  promotionFile: string;
  reportFile: string;
  accountFile: string;
  databaseUrl?: string;
}

type Environment = Record<string, string | undefined>;

const fileDefinitions = [
  ['ARTWORK_DATA_FILE', 'artworkFile', 'artworks.json'],
  ['PROGRESSION_DATA_FILE', 'progressionFile', 'progression.json'],
  ['MINT_DATA_FILE', 'mintFile', 'mint-lifecycle.json'],
  ['PROMOTION_DATA_FILE', 'promotionFile', 'promotions.json'],
  ['REPORT_DATA_FILE', 'reportFile', 'moderation-reports.json'],
  ['ACCOUNT_DATA_FILE', 'accountFile', 'accounts.json'],
] as const;

export function loadPersistenceConfiguration(environment: Environment = process.env, workingDirectory = process.cwd()): PersistenceConfiguration {
  const production = environment.NODE_ENV === 'production';
  const values = Object.fromEntries(fileDefinitions.map(([variable, property, fallback]) => [property, environment[variable]?.trim() || resolve(workingDirectory, '.data', fallback)])) as unknown as Omit<PersistenceConfiguration, 'databaseUrl'>;
  const databaseUrl = environment.DATABASE_URL?.trim() || undefined;

  if (production) {
    if (!databaseUrl) throw new Error('DATABASE_URL is required in production; account identity must not fall back to a release-local JSON file');
    // Every durable production repository uses PostgreSQL. File values remain
    // available solely for development and test environments.
  }

  return { ...values, databaseUrl };
}
