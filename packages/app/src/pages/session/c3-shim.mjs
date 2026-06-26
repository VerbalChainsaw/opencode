/**
 * C3 shim — re-implementation of createOrderedChainRefresh with the
 * backpressure option, mirroring the production logic in
 * packages/app/src/pages/session/goal-panel-pure.ts. This shim exists
 * so node:test can exercise the backpressure contract without bun
 * being available; the bun-based tests in
 * packages/app/src/pages/session/goal-panel-pure.test.ts pin the
 * production function directly.
 *
 * The implementations MUST stay equivalent. If they diverge, the
 * shape is broken — this shim is a verification surface, not a
 * re-implementation to maintain.
 */

export function createOrderedChainRefresh(readFn, onCommit, opts = {}) {
  const backpressure = opts.backpressure === true;
  let current = 0;
  let disposed = false;
  let inFlight = null;

  function request() {
    if (disposed) return Promise.resolve();
    if (backpressure && inFlight) return inFlight;
    const myGeneration = ++current;
    const readPromise = readFn().then(
      (data) => {
        if (backpressure && inFlight && inFlight === readPromise) {
          inFlight = null;
        }
        if (disposed) return;
        if (myGeneration !== current) return;
        onCommit(data);
      },
      (err) => {
        if (backpressure && inFlight && inFlight === readPromise) {
          inFlight = null;
        }
        void err;
      },
    );
    if (backpressure) {
      inFlight = readPromise;
    }
    return readPromise;
  }

  function dispose() {
    disposed = true;
  }

  return { request, dispose };
}