import { FatalError, RetryableError } from 'workflow';
import { POST as analyzeRequest } from '../app/api/analyze/route.js';
import { createBackgroundAnalysisAuthorization } from '../lib/security.js';

function resultTask(task) {
  const { body: omittedBody, requestId: omittedRequestId, ...context } = task;
  return context;
}

async function analyzeGameStep(task) {
  'use step';

  const authorization = await createBackgroundAnalysisAuthorization(task.body);
  const response = await analyzeRequest(new Request('https://background-analysis.internal/api/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': task.requestId,
      'X-Background-Analysis-Time': authorization.timestamp,
      'X-Background-Analysis-Signature': authorization.signature,
    },
    body: JSON.stringify(task.body),
  }));
  const payload = await response.json();
  if (response.status === 429) throw new RetryableError(payload?.error || '分析請求過於頻繁', { retryAfter: '20s' });
  if (response.status >= 500) throw new RetryableError(payload?.error || `分析伺服器錯誤（${response.status}）`, { retryAfter: '10s' });
  if (!response.ok || payload?.ok === false) {
    return {
      ok: false,
      status: response.status,
      error: payload?.error || `分析失敗（${response.status}）`,
      code: payload?.code || '',
      blocking: Array.isArray(payload?.blocking) ? payload.blocking : [],
      warnings: Array.isArray(payload?.warnings) ? payload.warnings : [],
      retryable: false,
      task: resultTask(task),
    };
  }
  return { ok: true, status: response.status, payload, task: resultTask(task) };
}

analyzeGameStep.maxRetries = 2;

export async function analyzeBoardWorkflow(input) {
  'use workflow';

  if (!input || !Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 20) {
    throw new FatalError('背景分析工作缺少有效場次');
  }
  const results = [];
  const concurrency = input.league === 'MLB' ? 2 : 1;
  for (let offset = 0; offset < input.tasks.length; offset += concurrency) {
    const batch = input.tasks.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(batch.map(task => analyzeGameStep(task)));
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      results.push(result.status === 'fulfilled'
        ? result.value
        : {
          ok: false,
          status: 500,
          error: String(result.reason?.message || result.reason || '背景分析失敗'),
          code: 'BACKGROUND_STEP_FAILED',
          blocking: [],
          warnings: [],
          retryable: true,
          task: resultTask(batch[index]),
        });
    }
  }
  return {
    ok: results.every(result => result.ok),
    league: input.league,
    date: input.date,
    total: results.length,
    completed: results.filter(result => result.ok).length,
    results,
  };
}
