export const SCREEN_AWAKE_MS = 5 * 60 * 1000;

// Browser dependencies are injectable so expiry and asynchronous OS releases
// can be tested without pretending a desktop test proves phone hardware behavior.
export function createScreenAwake({ doc, nav, now = Date.now, schedule = setTimeout, cancel = clearTimeout, onStatus = () => {} }) {
  let deadline = 0, timer, sentinel, pending = false, disposed = false, paused = false, epoch = 0;
  const supported = typeof nav?.wakeLock?.request === 'function';
  const eligible = () => !disposed && !paused && now() < deadline && doc.visibilityState === 'visible';
  const status = value => { if (!disposed) onStatus(value); };
  const release = () => {
    const held = sentinel;
    sentinel = undefined;
    if (held) Promise.resolve().then(() => held.release()).catch(() => {});
  };
  async function acquire() {
    if (!supported || !eligible() || pending || sentinel) return;
    pending = true;
    const requestedEpoch = epoch;
    status('pending');
    try {
      const held = await nav.wakeLock.request('screen');
      if (!eligible() || requestedEpoch !== epoch) {
        await held.release();
        return;
      }
      if (held.released) { status('blocked'); return; }
      sentinel = held;
      held.addEventListener('release', () => {
        if (sentinel !== held) return;
        sentinel = undefined;
        // No retry loop when the operating system refuses to keep the screen on.
        status(eligible() ? 'blocked' : 'idle');
      }, { once: true });
      status('active');
    } catch {
      if (eligible() && requestedEpoch === epoch) status('blocked');
    } finally {
      pending = false;
      if (requestedEpoch !== epoch && eligible()) void acquire();
    }
  }
  function renew() {
    if (disposed || paused) return;
    if (!supported) { status('unsupported'); return; }
    deadline = now() + SCREEN_AWAKE_MS;
    cancel(timer);
    timer = schedule(() => {
      epoch++;
      release();
      status('idle');
    }, SCREEN_AWAKE_MS);
    void acquire();
  }
  function visibility() {
    if (disposed || paused) return;
    if (!supported) { status('unsupported'); return; }
    epoch++;
    if (doc.visibilityState !== 'visible') { release(); status('idle'); }
    else if (eligible()) void acquire();
  }
  function pause() {
    paused = true;
    epoch++;
    cancel(timer);
    release();
    status('paused');
  }
  return {
    renew, visibility, pause,
    suspend() { epoch++; release(); status(!supported ? 'unsupported' : paused ? 'paused' : 'idle'); },
    resume() { paused = false; renew(); },
    dispose() { disposed = true; epoch++; cancel(timer); release(); },
  };
}
