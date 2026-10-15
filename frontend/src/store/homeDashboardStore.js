import { useQuery } from "@tanstack/react-query";
import { api } from "../services/api";
import { queryKeys, STALE } from "../lib/queryKeys";

/**
 * The HOME dashboard's statistics (the "/" page), fetched ONCE and shared by
 * every widget. Not to be confused with store/dashboardStore.js, which is the
 * Inventory dashboard (IMS M5).
 *
 * KPIStats, ConversionSummary, ActivityFeed and RevenueChart each used to call
 * `/dashboard/stats` themselves. Three of those requests were identical and the
 * fourth (`?range=6m`) asked for the server's default range, so a dashboard load
 * cost four copies of the same ~19-query response. They now share one TanStack
 * Query: the first widget starts the request, the rest join it, and a revisit
 * within STALE.dashboard is answered from cache (and refreshed after that).
 * Every booking change invalidates it — see store/invalidation.js.
 *
 * The chart's default range is the same 6-month trend the shared payload already
 * carries, so it reads that. Only a DIFFERENT range costs a request.
 */

// The range the server uses when none is sent (api.routes.js, `RANGES['6m']`).
export const DEFAULT_TREND_RANGE = "6m";

// One shared empty trend, so "no data" is the same value on every render (the
// chart defers on identity — see RevenueChart).
const NO_TREND = [];

const fetchStats = async (range, signal) => {
  const r = await api.get(
    "/dashboard/stats",
    range ? { params: { range }, signal } : { signal },
  );
  return r.data?.data ?? null;
};

/**
 * The shared stats for a widget. `loading` is true only while there is nothing
 * to show; a failed load reports `failed` and leaves `stats` null, which every
 * widget already renders as its empty state.
 */
export const useDashboardStats = () => {
  const q = useQuery({
    queryKey: queryKeys.dashboard.stats(),
    queryFn: ({ signal }) => fetchStats(undefined, signal),
    staleTime: STALE.dashboard,
  });
  return { stats: q.data ?? null, loading: q.isPending, failed: q.isError && !q.data };
};

/**
 * The demand trend for a range. The default range reads the shared payload;
 * any other range is fetched once per stale window.
 */
export const useDashboardTrend = (range) => {
  const isDefault = range === DEFAULT_TREND_RANGE;
  const { stats, loading: statsLoading } = useDashboardStats();
  const other = useQuery({
    queryKey: queryKeys.dashboard.stats(range),
    queryFn: ({ signal }) => fetchStats(range, signal),
    staleTime: STALE.dashboard,
    enabled: !isDefault,
  });

  if (isDefault) return { trend: stats?.monthlyTrend || NO_TREND, loading: statsLoading };
  return { trend: other.data?.monthlyTrend || NO_TREND, loading: other.isPending };
};
