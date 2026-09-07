import React, { useState, useEffect } from 'react';
import { Drawer } from '../ui/Drawer';
import { 
  Boxes, 
  Package, 
  Copy, 
  Check, 
  MapPin, 
  FileText, 
  Activity, 
  Truck
} from 'lucide-react';
import toast from 'react-hot-toast';
import { productsApi } from '../../services/products';
import { productDetailsApi } from '../../services/productDetails';
import { ProductContentSection } from './ProductContentSection';
import { useUserStore } from '../../store/userStore';
import { isMsilCustomer } from '../../utils/moq';
import { useShowMsilCode } from '../../hooks/useShowMsilCode';
import { isAdmin, isSales } from '../../utils/permissions';

const BRAND_COLORS = {
  KOKEN: 'bg-blue-50 text-blue-700 border-blue-200',
  BIX: 'bg-amber-50 text-amber-700 border-amber-200',
  IMADA: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

export const DetailsDrawer = ({
  isOpen,
  onClose,
  product,
  showMsilCode = false,
  showBoxNo = false,
}) => {
  const [copied, setCopied] = useState(false);
  const [item, setItem] = useState(product);
  /**
   * The SKU's descriptive content — photographs, description, videos.
   *
   * Fetched separately from the product itself, and deliberately allowed to
   * fail on its own: it is a different collection behind a different endpoint,
   * and a content service having a bad day must not stop the panel showing the
   * stock figures, which is what most people opened it for.
   */
  const [content, setContent] = useState(null);
  const [contentLoading, setContentLoading] = useState(false);
  const user = useUserStore((s) => s.user);
  const userShowMsil = useShowMsilCode();
  const isMsilUser = isMsilCustomer(user);
  const canSeeMsilCode = showMsilCode || userShowMsil;
  const canSeePlanning = isAdmin(user) || isSales(user);

  useEffect(() => {
    setItem(product);
    if (isOpen && product?.code && product?.brand) {
      productsApi
        .getByCode(product.brand.toLowerCase(), product.code)
        .then((fetched) => {
          if (fetched) {
            setItem((prev) => ({ ...prev, ...fetched }));
          }
        })
        .catch(() => {
          // Ignore fetch error, fallback to product prop
        });
    }
  }, [isOpen, product]);

  // Content follows the SKU CODE, not the product object: the same SKU reopened
  // from a re-rendered row must not refetch, and a different SKU must not show
  // the previous one's photographs for a frame.
  useEffect(() => {
    const code = product?.code;
    if (!isOpen || !code) return undefined;

    let cancelled = false;
    setContent(null);
    setContentLoading(true);

    productDetailsApi
      .get(code)
      .then((fetched) => { if (!cancelled) setContent(fetched); })
      // Silent by design. A SKU with no content and a content endpoint that is
      // down look the same from here, and both mean "show the placeholders" —
      // a toast would be an error message about something nobody asked for.
      .catch(() => { if (!cancelled) setContent(null); })
      .finally(() => { if (!cancelled) setContentLoading(false); });

    return () => { cancelled = true; };
  }, [isOpen, product?.code]);

  if (!product) return null;

  const currentItem = item || product;

  const handleCopySku = () => {
    if (currentItem?.code) {
      navigator.clipboard.writeText(currentItem.code);
      setCopied(true);
      toast.success(`Copied SKU "${currentItem.code}" to clipboard!`);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const getStatusBadge = (status) => {
    const s = (status || 'active').toLowerCase();
    if (s === 'active') {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5 animate-pulse" />
          Active
        </span>
      );
    }
    if (s === 'inactive') {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-200">
          <span className="w-1.5 h-1.5 rounded-full bg-slate-400 mr-1.5" />
          Inactive
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200">
        <span className="w-1.5 h-1.5 rounded-full bg-rose-500 mr-1.5" />
        Discontinued
      </span>
    );
  };

  const brandClass = BRAND_COLORS[currentItem.brand?.toUpperCase()] || 'bg-slate-100 text-slate-700 border-slate-200';

  const stockAvailable = currentItem.availableStock ?? currentItem.availableForSale ?? 0;
  const stockReserved = currentItem.reservedStock ?? currentItem.bookedQuantity ?? 0;
  const stockTotal = currentItem.totalAvailableQuantity || (stockAvailable + stockReserved);
  const stockInTransit = currentItem.inTransitQty ?? 0;
  const moq = currentItem.moq || 1;

  return (
    <Drawer isOpen={isOpen} onClose={onClose} title="Inventory Details" maxWidth="max-w-xl">
      <div className="space-y-6 pb-6">
        {/* Header Hero Card */}
        <div className="bg-gradient-to-br from-slate-900 via-primary-950 to-primary-900 rounded-xl p-5 text-white shadow-md relative overflow-hidden border border-primary-800/40">
          <div className="absolute -right-6 -bottom-6 w-36 h-36 bg-primary-500/20 rounded-full blur-2xl pointer-events-none" />
          
          <div className="flex items-start justify-between gap-3 relative z-10">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className={`px-2.5 py-0.5 text-xs font-bold rounded-md border ${brandClass}`}>
                  {currentItem.brand || 'GENERIC'}
                </span>
                {getStatusBadge(currentItem.status)}
              </div>
              <h2 className="text-xl font-mono font-bold tracking-tight text-white flex items-center gap-2 mt-2">
                {currentItem.code}
                <button
                  type="button"
                  onClick={handleCopySku}
                  className="p-1 text-primary-200/80 hover:text-white rounded hover:bg-white/10 transition-colors"
                  title="Copy SKU"
                >
                  {copied ? <Check size={16} className="text-emerald-400" /> : <Copy size={16} />}
                </button>
              </h2>
              {currentItem.name && currentItem.name !== currentItem.code && (
                <p className="text-sm text-primary-100/90 font-medium mt-1">{currentItem.name}</p>
              )}
            </div>

            <div className="p-3 bg-primary-950/60 rounded-xl border border-primary-700/50 shadow-inner flex items-center justify-center">
              <Boxes className="w-8 h-8 text-primary-300" />
            </div>
          </div>

          {currentItem.description && (
            <p className="text-xs text-primary-100/80 mt-3 pt-3 border-t border-primary-800/50 line-clamp-2">
              {currentItem.description}
            </p>
          )}
        </div>

        {/* Stock Snapshot Grid */}
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5">
            <Boxes className="w-3.5 h-3.5 text-slate-500" />
            Stock Balances
          </h3>
          <div className="grid grid-cols-2 gap-3">
            {/* Available Stock */}
            <div className={`p-4 rounded-xl border ${
              !isMsilUser && stockAvailable < moq
                ? 'bg-rose-50/60 border-rose-200'
                : 'bg-emerald-50/60 border-emerald-200'
            }`}>
              <div className="flex items-center justify-between text-xs font-semibold text-slate-600 mb-1">
                <span>Available for Sale</span>
                <span className={`w-2 h-2 rounded-full ${!isMsilUser && stockAvailable < moq ? 'bg-rose-500' : 'bg-emerald-500'}`} />
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className={`text-2xl font-bold font-mono ${
                  !isMsilUser && stockAvailable < moq ? 'text-rose-700' : 'text-emerald-700'
                }`}>
                  {stockAvailable.toLocaleString()}
                </span>
                <span className="text-xs font-medium text-slate-500">{currentItem.unit || 'PCS'}</span>
              </div>
              {!isMsilUser && stockAvailable < moq && (
                <span className="inline-block mt-1 text-[11px] font-semibold text-rose-600">
                  Below MOQ ({moq})
                </span>
              )}
            </div>

            {/* Booked / Reserved Stock */}
            <div className="p-4 rounded-xl border bg-blue-50/60 border-blue-200">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-600 mb-1">
                <span>Reserved / Booked</span>
                <span className="w-2 h-2 rounded-full bg-blue-500" />
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-bold font-mono text-blue-700">
                  {stockReserved.toLocaleString()}
                </span>
                <span className="text-xs font-medium text-slate-500">{currentItem.unit || 'PCS'}</span>
              </div>
              <span className="inline-block mt-1 text-[11px] text-blue-600 font-medium">
                Allocated to Orders
              </span>
            </div>

            {/* Total On-Hand */}
            <div className="p-4 rounded-xl border bg-slate-50 border-slate-200">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-600 mb-1">
                <span>Total Physical Stock</span>
                <Package className="w-3.5 h-3.5 text-slate-400" />
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-xl font-bold font-mono text-slate-800">
                  {stockTotal.toLocaleString()}
                </span>
                <span className="text-xs font-medium text-slate-500">{currentItem.unit || 'PCS'}</span>
              </div>
            </div>

            {/* In-Transit Stock */}
            <div className="p-4 rounded-xl border bg-amber-50/60 border-amber-200">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-600 mb-1">
                <span>In-Transit Stock</span>
                <Truck className="w-3.5 h-3.5 text-amber-500" />
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-xl font-bold font-mono text-amber-800">
                  {stockInTransit.toLocaleString()}
                </span>
                <span className="text-xs font-medium text-slate-500">{currentItem.unit || 'PCS'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Photographs, the long description and the videos.
            Placed above the master fields because it is what a customer opened
            the panel to see; the stock and planning figures below are what
            staff came for, and they were already on the row. */}
        <ProductContentSection
          skuCode={currentItem.code}
          detail={content}
          loading={contentLoading}
        />

        {/* Specifications & Master Details */}
        <div className="bg-slate-50/80 rounded-xl p-4 border border-slate-200 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5 text-slate-500" />
            Product Details
          </h3>

          <div className="divide-y divide-slate-200/70 text-sm">
            <div className="py-2 flex items-center justify-between">
              <span className="text-slate-500 font-medium">SKU Code</span>
              <span className="font-mono font-semibold text-slate-900">{currentItem.code}</span>
            </div>

            {canSeeMsilCode && (
              <div className="py-2 flex items-center justify-between">
                <span className="text-slate-500 font-medium">MSIL Code</span>
                <span className="font-mono font-semibold text-slate-800">
                  {currentItem.msilCode || <span className="text-slate-400 font-normal">-</span>}
                </span>
              </div>
            )}

            {(showBoxNo || currentItem.boxNo) && (
              <div className="py-2 flex items-center justify-between">
                <span className="text-slate-500 font-medium flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5 text-slate-400" /> Box No.
                </span>
                <span className="font-mono font-bold text-slate-800 bg-white px-2 py-0.5 rounded border border-slate-200 text-xs">
                  {currentItem.boxNo || '-'}
                </span>
              </div>
            )}

            <div className="py-2 flex items-center justify-between">
              <span className="text-slate-500 font-medium">Brand / Vendor</span>
              <span className="font-semibold text-slate-800">{currentItem.brand || 'GENERIC'}</span>
            </div>

            <div className="py-2 flex items-center justify-between">
              <span className="text-slate-500 font-medium">Category</span>
              <span className="font-medium text-slate-800">{currentItem.category || 'Uncategorized'}</span>
            </div>

            <div className="py-2 flex items-center justify-between">
              <span className="text-slate-500 font-medium">Unit of Measure</span>
              <span className="font-semibold text-slate-700">{currentItem.unit || currentItem.uom || 'PCS'}</span>
            </div>

            {!isMsilUser && (
              <div className="py-2 flex items-center justify-between">
                <span className="text-slate-500 font-medium">Minimum Order Qty (MOQ)</span>
                <span className="font-bold text-slate-900">{currentItem.moq || 1} {currentItem.unit || 'PCS'}</span>
              </div>
            )}

            {currentItem.itemParameter && (
              <div className="py-2 flex items-center justify-between">
                <span className="text-slate-500 font-medium">Item Parameter</span>
                <span className="font-medium text-slate-800">{currentItem.itemParameter}</span>
              </div>
            )}
          </div>
        </div>

        {/* Planning & Inventory Analytics */}
        {canSeePlanning && (currentItem.abcClass || currentItem.leadTime > 0 || currentItem.safetyFactor > 0 || currentItem.currentSeason || currentItem.openingStockQuantity != null) && (
          <div className="bg-slate-50/80 rounded-xl p-4 border border-slate-200 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-slate-500" />
              Inventory Planning
            </h3>

            <div className="grid grid-cols-2 gap-3 pt-1">
              {currentItem.abcClass && (
                <div className="p-3 bg-white rounded-lg border border-slate-200">
                  <div className="text-[11px] font-medium text-slate-400">ABC Class</div>
                  <div className="text-base font-bold text-slate-800 mt-0.5 flex items-center gap-1">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${
                      currentItem.abcClass === 'A' ? 'bg-purple-100 text-purple-700' :
                      currentItem.abcClass === 'B' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'
                    }`}>
                      Class {currentItem.abcClass}
                    </span>
                  </div>
                </div>
              )}

              {currentItem.leadTime > 0 && (
                <div className="p-3 bg-white rounded-lg border border-slate-200">
                  <div className="text-[11px] font-medium text-slate-400">Lead Time</div>
                  <div className="text-base font-bold text-slate-800 mt-0.5">
                    {currentItem.leadTime} Days
                  </div>
                </div>
              )}

              {currentItem.safetyFactor > 0 && (
                <div className="p-3 bg-white rounded-lg border border-slate-200">
                  <div className="text-[11px] font-medium text-slate-400">Safety Factor</div>
                  <div className="text-base font-bold text-slate-800 mt-0.5">
                    {currentItem.safetyFactor}
                  </div>
                </div>
              )}

              {currentItem.currentSeason && (
                <div className="p-3 bg-white rounded-lg border border-slate-200">
                  <div className="text-[11px] font-medium text-slate-400">Current Season</div>
                  <div className="text-base font-bold text-slate-800 mt-0.5">
                    {currentItem.currentSeason}
                  </div>
                </div>
              )}

              {currentItem.openingStockQuantity != null && (
                <div className="p-3 bg-white rounded-lg border border-slate-200 col-span-2">
                  <div className="text-[11px] font-medium text-slate-400">Opening Stock</div>
                  <div className="text-sm font-bold text-slate-800 mt-0.5 flex items-center justify-between">
                    <span>{currentItem.openingStockQuantity.toLocaleString()} {currentItem.unit || 'PCS'}</span>
                    {currentItem.openingStockDate && (
                      <span className="text-xs font-normal text-slate-500">
                        {new Date(currentItem.openingStockDate).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Action Footer */}
        <div className="pt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={handleCopySku}
            className="flex-1 py-2.5 px-4 bg-primary-600 hover:bg-primary-700 text-white font-medium text-sm rounded-xl transition-colors shadow-sm flex items-center justify-center gap-2 cursor-pointer"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            {copied ? 'SKU Copied' : 'Copy SKU Code'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="py-2.5 px-5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium text-sm rounded-xl transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </Drawer>
  );
};

export default DetailsDrawer;