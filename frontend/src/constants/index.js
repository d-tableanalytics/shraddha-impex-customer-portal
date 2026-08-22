export const ROUTES = {
  DASHBOARD: "/",
  CREATE_ORDER: "/orders/new",
  ORDER_HISTORY: "/orders/history",
  BULK_UPLOAD: "/orders/bulk-upload",
  ADMIN: "/admin",
};

// Product data is no longer hardcoded — it is fetched live from MongoDB
// via productsApi.search(query) → GET /api/v1/products/search?search=... (all brands the user may see)
// See: frontend/src/services/products.js
