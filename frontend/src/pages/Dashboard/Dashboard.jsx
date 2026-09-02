import { PageHeader } from "../../components/common/PageHeader";
import { KPIStats } from "../../components/dashboard/KPIStats";
import { RevenueChart } from "../../components/dashboard/RevenueChart";
import { ConversionSummary } from "../../components/dashboard/ConversionSummary";
import { ActivityFeed } from "../../components/dashboard/ActivityFeed";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { PlusCircle, UploadCloud, Boxes } from "lucide-react";

import { useUserStore } from "../../store/userStore";
import { canUseOrdering } from "../../utils/permissions";

export const Dashboard = () => {
  const navigate = useNavigate();
  const { user } = useUserStore();
  const isAdmin = user?.role === "Admin";
  /**
   * Whether to show the booking half of the dashboard at all.
   *
   * The conversion funnel, the demand chart and the recent-bookings feed are
   * BOOKING sections. For a role that holds no ordering permission they are
   * three panels of zeroes leading to screens it cannot open — and for the
   * Import Team role specifically, the requirement is that booking sections are
   * absent rather than empty. The stock tiles above them stay, because those
   * are what such a role came for.
   */
  const worksOrders = canUseOrdering(user);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <PageHeader
          title={isAdmin ? "Admin Dashboard" : "Dashboard"}
          hideMeta
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => navigate('/inventory')}>
                <Boxes size={16} className="mr-2" />
                Inventory
              </Button>
              {worksOrders && (
                <>
                  <Button size="sm" variant="outline" onClick={() => navigate('/orders/bulk-upload')}>
                    <UploadCloud size={16} className="mr-2" />
                    Bulk Upload
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => navigate('/orders/new')}>
                    <PlusCircle size={16} className="mr-2" />
                    New Booking
                  </Button>
                </>
              )}
            </div>
          }
        />
      </div>

      <KPIStats />

      {worksOrders && (
        <>
          <ConversionSummary />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <RevenueChart />
            </div>
            <div>
              <ActivityFeed />
            </div>
          </div>
        </>
      )}
    </div>
  );
};
