// NBA sports-data workspace. This namespace is intentionally independent of
// the existing baseball league registry, analytical jobs and ledger.
export const NBA_MODULE_VERSION = 'NBA-DATA-1.3.0';
export const NBA_LEAGUE = 'NBA';
export const NBA_TIMEZONE = 'Asia/Taipei';
export const NBA_CACHE_PREFIX = 'sports-data:nba:v1';
export const NBA_PAGE_PATH = '/nba';
export const NBA_API_PATH = '/api/nba';

export const NBA_SOURCES = Object.freeze({
  schedule: 'https://www.nba.com/schedule',
  statistics: 'https://www.nba.com/stats',
  injuries: 'https://official.nba.com',
  espn: 'https://www.espn.com/nba/',
});
