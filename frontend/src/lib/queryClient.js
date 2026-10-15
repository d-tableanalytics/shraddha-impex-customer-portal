import { QueryClient } from "@tanstack/react-query";
import { registerSessionReset } from "../store/sessionReset";

/**
 * The one TanStack Query client for the portal.
 *
 * It used to be created inside App.jsx and never used. It is now shared so that
 * code outside components (stores, mutation handlers) can invalidate what it
 * changed, and so a change of account can drop every cached response.
 *
 * Defaults are conservative on purpose. A query that wants to be served from
 * cache says so with its own `staleTime` (see queryKeys.js for the policy per
 * resource); nothing is assumed fresh by default.
 */

/** Retry a transient failure once; never retry a refusal the server meant. */
const retry = (failureCount, error) => {
  const status = error?.response?.status;
  if (status && status >= 400 && status < 500) return false;
  return failureCount < 1;
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: 5 * 60 * 1000,
      retry,
      refetchOnWindowFocus: false,
    },
    mutations: {
      // A write is never replayed behind the user's back.
      retry: false,
    },
  },
});

// Cached responses belong to the account that fetched them. Cancel anything in
// flight first so a late answer cannot repopulate the cache after the clear.
registerSessionReset(() => {
  queryClient.cancelQueries();
  queryClient.clear();
});
