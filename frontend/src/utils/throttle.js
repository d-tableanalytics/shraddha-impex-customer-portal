/**
 * Run `fn` at most once per `waitMs`, and always once more after the last call.
 *
 * The first call runs immediately (a lone stock change still shows at once).
 * Calls that arrive during the wait collapse into ONE trailing run when the wait
 * ends, so the final state of a burst is always fetched and nothing is dropped —
 * only the redundant middle of the burst is.
 *
 * Returns the throttled function with `.cancel()`, for unmount cleanup.
 */
export const throttleTrailing = (fn, waitMs) => {
  let timer = null;
  let pending = false;
  let lastArgs = [];

  const startWindow = () => {
    timer = setTimeout(() => {
      timer = null;
      if (pending) {
        pending = false;
        fn(...lastArgs);
        startWindow();
      }
    }, waitMs);
  };

  const throttled = (...args) => {
    lastArgs = args;
    if (timer) {
      pending = true;
      return;
    }
    fn(...args);
    startWindow();
  };

  throttled.cancel = () => {
    clearTimeout(timer);
    timer = null;
    pending = false;
  };

  return throttled;
};
