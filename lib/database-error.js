const DEFAULT_RETRY_AFTER_SECONDS = 5 * 60;
const QUOTA_RETRY_AFTER_SECONDS = 6 * 60 * 60;

function errorChain(error) {
  const values = [];
  const seen = new Set();
  let current = error;
  while (current != null && values.length < 6 && !seen.has(current)) {
    values.push(current);
    if ((typeof current !== 'object' && typeof current !== 'function') || current.cause == null) break;
    seen.add(current);
    current = current.cause;
  }
  return values;
}

function errorPart(value) {
  if (value == null) return '';
  if (typeof value !== 'object' && typeof value !== 'function') return String(value);
  return [value.name, value.code, value.message]
    .map(part => String(part || '').trim())
    .filter(Boolean)
    .join(': ');
}

function messageOf(error) {
  return errorChain(error).map(errorPart).filter(Boolean).join(' | ').trim();
}

function upstreamStatusOf(error) {
  for (const value of errorChain(error)) {
    const status = Number(value?.status || value?.statusCode || 0);
    if (Number.isFinite(status) && status > 0) return status;
  }
  return null;
}

function redact(value) {
  return String(value || '')
    .replace(/(?:postgres(?:ql)?):\/\/[^\s"']+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/(password|token|secret)=([^\s&]+)/gi, '$1=[REDACTED]')
    .slice(0, 2_000);
}

export function markDatabaseError(error, operation = 'DATABASE_OPERATION_FAILED') {
  if (errorChain(error).some(value => value?.databaseOperation === true)) return error;
  const wrapped = new Error(messageOf(error) || 'Database operation failed', { cause: error });
  wrapped.name = 'DatabaseOperationError';
  wrapped.code = 'DATABASE_OPERATION_FAILED';
  wrapped.databaseOperation = true;
  wrapped.operation = String(operation || 'DATABASE_OPERATION_FAILED');
  return wrapped;
}

export function isDatabaseError(error) {
  const chain = errorChain(error);
  const names = chain.map(value => String(value?.name || '').toLowerCase()).join(' ');
  const message = messageOf(error).toLowerCase();
  const status = upstreamStatusOf(error);
  return chain.some(value => value?.databaseOperation === true)
    || names.includes('neondb')
    || status === 402
    || /database_url|server error \(http status|data transfer quota|exceeded[^.]*quota/.test(message)
    || /(relation|column|constraint)[^\n]*(does not exist|不存在)/.test(message)
    || /database[^\n]*(connection|timeout|unavailable)/.test(message);
}

export function classifyDatabaseError(error) {
  const message = messageOf(error);
  const lower = message.toLowerCase();
  const upstreamStatus = upstreamStatusOf(error);

  if ((upstreamStatus === 402 || /http status 402/.test(lower))
    && /(data transfer quota|exceeded[^.]*quota|quota[^.]*exceeded)/.test(lower)) {
    return {
      code: 'DATABASE_TRANSFER_QUOTA_EXCEEDED',
      status: 503,
      retryAfterSeconds: QUOTA_RETRY_AFTER_SECONDS,
      publicMessage: '永久資料庫傳輸額度已用完；雲端讀寫已暫停，請恢復 Neon 配額後再試。',
      diagnostic: redact(message),
      upstreamStatus: upstreamStatus || 402,
    };
  }

  if (/database_url/.test(lower) && /(not configured|尚未設定|missing|required)/.test(lower)) {
    return {
      code: 'DATABASE_NOT_CONFIGURED',
      status: 503,
      retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
      publicMessage: '永久資料庫尚未完成設定；雲端帳本與 PIT 寫入已停止。',
      diagnostic: redact(message),
      upstreamStatus,
    };
  }

  if (/(relation|column|constraint)[^\n]*(does not exist|不存在)|schema[^\n]*(missing|invalid|不存在)/.test(lower)) {
    return {
      code: 'DATABASE_SCHEMA_UNAVAILABLE',
      status: 503,
      retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
      publicMessage: '永久資料庫結構尚未就緒；已停止讀寫，避免產生不完整紀錄。',
      diagnostic: redact(message),
      upstreamStatus,
    };
  }

  return {
    code: 'DATABASE_UNAVAILABLE',
    status: 503,
    retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
    publicMessage: '永久資料庫目前無法使用；雲端帳本與 PIT 寫入已暫停。',
    diagnostic: redact(message || error?.name || 'UNKNOWN_DATABASE_ERROR'),
    upstreamStatus,
  };
}

export function databaseFailureLog(error, operation = 'DATABASE_OPERATION_FAILED') {
  const failure = classifyDatabaseError(error);
  return {
    operation,
    code: failure.code,
    upstreamStatus: failure.upstreamStatus,
    diagnostic: failure.diagnostic,
  };
}
