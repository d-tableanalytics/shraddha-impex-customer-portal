import { useEffect } from "react";
import { PageHeader } from "../../components/common/PageHeader";
import { IndentMetricsCard } from "../../components/cards/IndentMetricsCard";
import { IndentToolbar } from "../../components/layout/IndentToolbar";
import { IndentHistoryTable } from "../../components/tables/IndentHistoryTable";
import { IndentDrawer } from "../../components/drawer/IndentDrawer";
import { useIndentHistoryStore } from "../../store/indentHistoryStore";
import { useUserStore } from "../../store/userStore";

export const IndentHistory = () => {
  const { fetchIndents } = useIndentHistoryStore();
  const isAdmin = useUserStore((s) => s.user?.role === "Admin");

  useEffect(() => {
    fetchIndents();
  }, [fetchIndents]);

  return (
    <div className="flex flex-col gap-6 relative">
      <PageHeader title="Indent History" />
      <p className="text-slate-600 -mt-2 text-sm">
        {isAdmin
          ? "Track, search and manage unfulfilled quantities across all customers."
          : "Track and search your unfulfilled quantities, awaiting fresh stock."}
      </p>

      <IndentMetricsCard />

      <IndentToolbar />

      <IndentHistoryTable />

      <IndentDrawer />
    </div>
  );
};

export default IndentHistory;
