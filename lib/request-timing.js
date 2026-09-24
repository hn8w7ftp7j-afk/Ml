export function createRequestTiming(route, { now = Date.now, log = row => console.info(JSON.stringify(row)) } = {}) {
  const started = now();
  const stages = [];
  return {
    async measure(stage, operation) {
      const start = now();
      let outcome = 'failed';
      try { const result = await operation(); outcome = 'ok'; return result; }
      finally { stages.push({ stage, durationMs: Math.max(0, now() - start), outcome }); }
    },
    finish(response) {
      const durationMs = Math.max(0, now() - started);
      try { log({ event: 'REQUEST_STAGE_TIMING', route, status: response.status, durationMs, stages }); } catch {}
      response.headers.set('Server-Timing', `total;dur=${durationMs}`);
      return response;
    },
  };
}
