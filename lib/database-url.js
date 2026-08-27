const cleanDatabaseUrl = value => String(value || '').trim();

export function durableDatabaseUrl(env = process.env) {
  return cleanDatabaseUrl(env?.DATABASE_V2_URL) || cleanDatabaseUrl(env?.DATABASE_URL);
}

export function durableDatabaseConfigured(env = process.env) {
  return Boolean(durableDatabaseUrl(env));
}
