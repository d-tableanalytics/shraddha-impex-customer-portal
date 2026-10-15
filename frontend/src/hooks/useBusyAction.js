import { useCallback, useRef, useState } from "react";
import toast from "react-hot-toast";

/**
 * Busy state for buttons whose work takes noticeable time — exports that
 * lazy-load xlsx/jspdf and build a file, prints, small admin actions.
 *
 *   const { isBusy, run } = useBusyAction();
 *   <button disabled={isBusy("pdf")} onClick={() => run("pdf", buildPdf, { error: "PDF export failed" })}>
 *
 * While `key` is running, `isBusy(key)` is true and a second click is ignored
 * (no duplicate files, no double submissions). A thrown error, or an action
 * that resolves to `false` (the exportUtils convention), shows `error` as a
 * toast; `success`, when given, is toasted on completion.
 *
 * Keys let one component track several actions (Excel and PDF side by side)
 * without each one disabling the other.
 */
export const useBusyAction = () => {
  const [busyKeys, setBusyKeys] = useState(() => new Set());
  // A ref as well as state: two clicks inside one render must not both start.
  const running = useRef(new Set());

  const run = useCallback(async (key, action, { success, error } = {}) => {
    if (running.current.has(key)) return undefined;
    running.current.add(key);
    setBusyKeys(new Set(running.current));
    // Let the busy state paint before a synchronous build blocks the thread.
    await new Promise((r) => setTimeout(r, 0));
    try {
      const result = await action();
      if (result === false) {
        if (error) toast.error(error);
      } else if (success) {
        toast.success(success);
      }
      return result;
    } catch (err) {
      toast.error(err?.response?.data?.message || error || err?.message || "Something went wrong.");
      return undefined;
    } finally {
      running.current.delete(key);
      setBusyKeys(new Set(running.current));
    }
  }, []);

  const isBusy = useCallback((key) => busyKeys.has(key), [busyKeys]);
  const anyBusy = busyKeys.size > 0;

  return { run, isBusy, anyBusy };
};

export default useBusyAction;
