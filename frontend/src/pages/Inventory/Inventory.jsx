import { useState, useEffect, useRef } from 'react';
import { Card, CardContent } from '../../components/ui/Card';
import { Boxes, AlertTriangle, Search, Download, Loader2, FileUp } from 'lucide-react';
import { useProductStore } from '../../store/productStore';
import { onStockUpdated } from '../../services/socketService';
import { useUserStore } from '../../store/userStore';
import { useShowMsilCode } from '../../hooks/useShowMsilCode';
import { allowedBrands } from '../../utils/brandAccess';
import { Pagination } from '../../components/ui/Pagination';
import { TableSkeleton } from '../../components/ui/TableSkeleton';
import { SkuLookupModal } from '../../components/inventory/SkuLookupModal';
import { productsApi } from '../../services/products';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';

const PAGE_SIZE = 12;

export const Inventory = () => {
  const { inventory, inventoryLoading, fetchInventory, exportInventory } = useProductStore();
  const { user } = useUserStore();
  const isAdmin = user?.role === "Admin";
  const showMsilCode = useShowMsilCode();
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // True from the first keystroke, not only once the request is in flight.
  // The search box waits 300ms before firing, and during that pause the old
  // rows sat there looking like the filter had been ignored. This spans the
  // debounce window and the request as one continuous "working" state.
  const filtering = inventoryLoading || searchTerm !== debouncedSearch;
  const [sortBy, setSortBy] = useState('name-asc');
  const [selectedBrand, setSelectedBrand] = useState('');
  const [page, setPage] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  // Debounce typing so a search costs one request rather than one per keystroke,
  // keeping load off the API and avoiding a burst of results racing each other.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Back to the first page whenever the result set changes underneath us.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, sortBy, selectedBrand]);

  // Search, sort and paging all run server-side, so this covers the whole
  // catalogue instead of whatever subset was downloaded.
  // Held in a ref so the socket listener below can re-run the CURRENT query
  // without being torn down and re-subscribed every time a filter changes.
  const load = useRef(() => {});
  load.current = () => fetchInventory({
    search: debouncedSearch,
    sort: sortBy,
    page,
    limit: PAGE_SIZE,
    brand: selectedBrand,
  });

  useEffect(() => {
    load.current();
  }, [fetchInventory, debouncedSearch, sortBy, page, selectedBrand]);

  // Stock arriving anywhere — an inward import, an adjustment, a posted count —
  // refreshes this list. Without it a customer kept looking at the figures as
  // they were when the page opened, and inward stock stayed invisible until
  // they happened to reload.
  useEffect(() => onStockUpdated(() => load.current()), []);

  const { items, total, pages, catalogueTotal, lowStockCount } = inventory;

  // A shrinking result set can leave us past the last page.
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [pages, page]);

  const availableBrands = allowedBrands(user);

  // Download the whole filtered catalogue (all pages) as Excel. The current
  // search and sort are applied so the file matches what's on screen.
  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const rows = await exportInventory({
        search: debouncedSearch,
        sort: sortBy,
        brand: selectedBrand
      });
      if (!rows.length) {
        toast.error('No products to export.');
        return;
      }
      const { exportToExcel } = await import('../../utils/exportUtils');
      const cols = [
        { key: 'code', label: 'SKU Code' },
        ...(showMsilCode ? [{ key: 'msilCode', label: 'MSIL Code', format: (v) => v || '-' }] : []),
        { key: 'name', label: 'Product Name' },
        { key: 'brand', label: 'Brand' },
        { key: 'category', label: 'Category' },
        { key: 'availableStock', label: 'In Stock' },
      ];
      exportToExcel(rows, cols, 'Inventory');
      toast.success(`Exported ${rows.length} product${rows.length === 1 ? '' : 's'}.`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to export inventory.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight">Inventory Dashboard</h2>
          <p className="text-sm text-slate-500 mt-1">Manage products, track stock levels, and monitor warehouse assets.</p>
        </div>
      </div>

      {/* KPIs — Low Stock is an internal supply signal, so it is Admin-only.
          Customers see the SKU count on its own, full width. */}
      <div className={`grid grid-cols-1 gap-6 ${isAdmin ? "md:grid-cols-2" : ""}`}>
        <Card className="bg-white border-slate-200">
          <CardContent className="p-6 flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-600">
              <Boxes size={24} />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Total SKUs</p>
              <h3 className="text-2xl font-bold text-slate-900">{catalogueTotal.toLocaleString()}</h3>
            </div>
          </CardContent>
        </Card>

        {isAdmin && (
          <Card className="bg-white border-slate-200">
            <CardContent className="p-6 flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center text-red-600">
                <AlertTriangle size={24} />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Low Stock</p>
                <h3 className="text-2xl font-bold text-slate-900">{lowStockCount.toLocaleString()}</h3>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {/* Header & Search */}
          <div className="p-4 border-b border-slate-200 bg-slate-50 flex flex-col md:flex-row justify-between items-center gap-4 rounded-t-xl">
            <div className="relative w-full md:w-96">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input 
                type="text" 
                placeholder={showMsilCode ? "Search by SKU, MSIL Code, or Name..." : "Search by SKU or Name..."}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 text-sm font-medium text-slate-800"
              />
            </div>
            <div className="flex flex-wrap gap-2 w-full md:w-auto">
              {/* Brand Filter */}
              {availableBrands.length > 1 && (
                <select
                  className="w-full md:w-auto px-3 py-1.5 border border-slate-300 rounded-md text-sm font-medium text-slate-700 bg-white outline-none focus:ring-1 focus:ring-primary-500 cursor-pointer"
                  value={selectedBrand}
                  onChange={(e) => setSelectedBrand(e.target.value)}
                >
                  <option value="">All Brands</option>
                  {availableBrands.map((b) => (
                    <option key={b} value={b.toUpperCase()}>{b}</option>
                  ))}
                </select>
              )}

              <select
                className="w-full md:w-auto px-3 py-1.5 border border-slate-300 rounded-md text-sm font-medium text-slate-700 bg-white outline-none focus:ring-1 focus:ring-primary-500 cursor-pointer"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
              >
                <option value="name-asc">Sort: A to Z</option>
                <option value="name-desc">Sort: Z to A</option>
                <option value="stock-desc">Sort: Stock (High-Low)</option>
                <option value="stock-asc">Sort: Stock (Low-High)</option>
              </select>
              <button
                onClick={() => setBulkOpen(true)}
                title="Upload a file of SKU codes to check availability"
                className="inline-flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-all shrink-0"
              >
                <FileUp size={16} /> Bulk SKU upload
              </button>
              <button
                onClick={handleDownload}
                disabled={downloading || total === 0}
                title="Download inventory as Excel"
                className="inline-flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-semibold text-white bg-primary-600 hover:bg-primary-700 rounded-md transition-all disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                {downloading ? 'Preparing…' : 'Download'}
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-4 font-bold text-slate-600 uppercase text-xs">SKU Code</th>
                  {showMsilCode && <th className="px-6 py-4 font-bold text-slate-600 uppercase text-xs">MSIL Code</th>}
                  <th className="px-6 py-4 font-bold text-slate-600 uppercase text-xs">Product Name</th>
                  <th className="px-6 py-4 font-bold text-slate-600 uppercase text-xs">Brand / Category</th>
                  <th className="px-6 py-4 font-bold text-slate-600 uppercase text-xs text-center">In Stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtering && (
                  <TableSkeleton rows={items.length || PAGE_SIZE} columns={showMsilCode ? 5 : 4} />
                )}
                <AnimatePresence>
                  {!filtering && items.map(product => (
                    <motion.tr 
                      key={product.code}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="hover:bg-slate-50 transition-colors"
                    >
                      <td className="px-6 py-4 font-bold text-slate-900">{product.code}</td>
                      {showMsilCode && <td className="px-6 py-4 font-semibold text-slate-600">{product.msilCode || '-'}</td>}
                      <td className="px-6 py-4 font-semibold text-slate-800">{product.name}</td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="font-bold text-slate-700 text-xs">{product.brand || 'GENERIC'}</span>
                          <span className="text-[11px] text-slate-500 font-medium">{product.category}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className={`inline-flex px-2 py-1 rounded-md text-xs font-bold ${
                          product.availableStock < (product.moq * 2 || 10) 
                          ? 'bg-red-50 text-red-600' 
                          : 'bg-success-50 text-success-700'
                        }`}>
                          {product.availableStock}
                        </span>
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
                {!inventoryLoading && items.length === 0 && (
                  <tr>
                    <td colSpan={showMsilCode ? 5 : 4} className="px-6 py-12 text-center text-slate-500 font-medium">
                      No products found matching your search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {total > 0 && (
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50/60 rounded-b-xl">
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                totalItems={total}
                onPageChange={setPage}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <SkuLookupModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title={showMsilCode ? "Check availability for a list of SKUs / MSIL Codes" : "Check availability for a list of SKUs"}
        intro={
          showMsilCode
            ? 'Upload a file containing a SKU Code and/or MSIL Code column. Nothing is ordered '
              + 'or changed — this only shows what is available for each code so you can review '
              + 'before booking.'
            : 'Upload a file containing a SKU Code column (or just a plain list of codes in the '
              + 'first column). Nothing is ordered or changed — this only shows what is available '
              + 'for each code so you can review before booking.'
        }
        showMsilCode={showMsilCode}
        lookup={showMsilCode ? productsApi.lookupCodes : productsApi.lookupSkus}
        columns={[
          {
            key: 'available',
            label: 'Available',
            align: 'right',
            className: 'font-bold text-primary-700',
            render: (r) => r.available.toLocaleString(),
          },
          {
            key: 'moq',
            label: 'Min Order',
            align: 'right',
            className: 'text-slate-500',
            render: (r) => (r.moq > 1 ? r.moq.toLocaleString() : '—'),
          },
        ]}
      />
    </div>
  );
};
