import { api } from "./api";

// Maps a Mongoose product document (from any brand collection) to the
// normalised shape used throughout the frontend.
const mapProduct = (p) => {
  if (!p) return null;
  return {
    id:             p._id,
    code:           p.skuCode,          // real field name from migration
    msilCode:       p.msilCode || null,
    // The SKU → box number mapping. Read-only everywhere it is shown; only an
    // admin can change it, through the inventory master.
    boxNo:          p.boxNo || null,
    name:           p.skuCode,          // products have no "name" column — use SKU as label
    brand:          p.vendorName || null,
    category:       Array.isArray(p.category) ? p.category.join(', ') : (p.category || null),
    warehouse:      null,               // not in Product schema
    availableStock: p.availableForSale ?? 0,
    reservedStock:  p.bookedQuantity  ?? 0,
    unit:           'PCS',
    moq:            p.moq || 1,
    // pass through remaining fields for detail panel
    totalAvailableQuantity: p.totalAvailableQuantity ?? 0,
    inTransitQty:   p.inTransitQty ?? 0,
    status:         p.status,
  };
};

export const productsApi = {
  // Resolve a list of SKU codes to what this customer can order. Read-only, and
  // scoped server-side to their permitted brands — a SKU outside them reports as
  // "not in the catalogue" rather than revealing it exists.
  lookupSkus: async (skuCodes) => {
    const response = await api.post('/products/lookup', { skuCodes });
    return { data: response.data.data || [], summary: response.data.summary };
  },

  // Resolve a list of SKU codes and/or MSIL codes. For MSIL users who may
  // upload a file containing either column — the backend resolves by whichever
  // code is provided and merges the results.
  lookupCodes: async (skuCodes, msilCodes) => {
    const response = await api.post('/products/lookup', { skuCodes, msilCodes });
    return { data: response.data.data || [], summary: response.data.summary };
  },

  // Search across the active user's accessible brand(s)
  search: async (query, brand = 'koken') => {
    if (!query) return [];
    const response = await api.get(`/products/${brand}?search=${encodeURIComponent(query)}`);
    return (response.data.data || []).map(mapProduct);
  },

  getAll: async (brand = 'koken', limit) => {
    const qs = limit ? `?limit=${limit}` : '';
    const response = await api.get(`/products/${brand}${qs}`);
    return (response.data.data || []).map(mapProduct);
  },

  // Fetch the full catalog across all brands (admin Inventory). Each product is
  // tagged with its source brand and low/zero-stock items are included.
  getAllBrands: async (limit = 2000) => {
    const brands = ['koken', 'bix', 'imada'];
    const lists = await Promise.all(
      brands.map(async (b) => {
        const list = await productsApi.getAll(b, limit);
        return list.map((p) => ({ ...p, brand: b.toUpperCase() }));
      })
    );
    return lists.flat();
  },

  // Inventory view across all brands. Search, sort, paging and the KPI counts
  // are resolved server-side, so they cover the whole catalogue rather than a
  // downloaded subset. `total` is the search-filtered count (drives paging);
  // `catalogueTotal` / `lowStockCount` describe the catalogue as a whole.
  getInventory: async ({ search = '', sort = 'name-asc', page = 1, limit = 12, brand = '', category = '' } = {}) => {
    const params = new URLSearchParams({ sort, page: String(page), limit: String(limit) });
    if (search) params.set('search', search);
    if (brand) params.set('brand', brand);
    if (category) params.set('category', category);
    const response = await api.get(`/products?${params.toString()}`);
    const { data, pagination, totals } = response.data;
    return {
      // The server tags each row with its source brand; keep that over the
      // vendorName mapProduct would otherwise use.
      items: (data || []).map((p) => ({ ...mapProduct(p), brand: p.brand })),
      total: pagination?.total ?? 0,
      pages: pagination?.pages ?? 1,
      catalogueTotal: totals?.catalogue ?? 0,
      lowStockCount: totals?.lowStock ?? 0,
    };
  },

  // Whole filtered catalogue in one request, for the Inventory download.
  // Honours the same search, sort and per-user brand rules as getInventory.
  getInventoryExport: async ({ search = '', sort = 'name-asc', brand = '', category = '' } = {}) => {
    const params = new URLSearchParams({ sort, all: 'true' });
    if (search) params.set('search', search);
    if (brand) params.set('brand', brand);
    if (category) params.set('category', category);
    const response = await api.get(`/products?${params.toString()}`);
    return (response.data.data || []).map((p) => ({ ...mapProduct(p), brand: p.brand }));
  },

  getByCode: async (brand = 'koken', skuCode) => {
    try {
      const response = await api.get(`/products/${brand}/${encodeURIComponent(skuCode)}`);
      return mapProduct(response.data.data);
    } catch (error) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  },

  getCategories: async () => {
    const response = await api.get('/products/categories');
    return response.data.data || [];
  },
};
