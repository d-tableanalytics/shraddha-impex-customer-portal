import { Navigate } from 'react-router-dom';

import { Card, CardContent } from '../../components/ui/Card';
import { PageHeader } from '../../components/common/PageHeader';
import { BrandSettings } from '../../components/inventory/BrandSettings';
import { useUserStore } from '../../store/userStore';
import { canConfigureInventory } from '../../utils/permissions';

/**
 * Inventory Management → Brands.
 *
 * The brand master. Everything brand-related in both portals — inventory
 * filters, imports, exports, reports, bookings, the account forms — builds its
 * options from this list, so adding a brand here is the only step.
 */
export const InventoryBrands = () => {
  const { user } = useUserStore();
  // The route and every request are guarded server-side; this only avoids
  // rendering a screen the user could not use.
  if (user && !canConfigureInventory(user)) return <Navigate to="/" replace />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Brands" />
      <Card>
        <CardContent className="p-6 flex flex-col gap-5">
          <p className="text-xs text-slate-500 leading-relaxed max-w-2xl">
            The brands the business sells. A brand added here appears in every brand list across
            both portals — inventory, imports, exports, reports, bookings and the account forms —
            with nothing else to update.
          </p>
          <BrandSettings />
        </CardContent>
      </Card>
    </div>
  );
};

export default InventoryBrands;
