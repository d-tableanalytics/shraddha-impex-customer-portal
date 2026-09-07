import { api } from "./api";

/**
 * Product content — descriptions, photographs and videos.
 *
 * Read by the inventory slide-over, written by the Admin → Product Details
 * screen. Nothing here touches stock: this is catalogue material, and it is
 * kept apart from the product APIs for exactly that reason.
 */

/**
 * Turn the server's relative image path into something an `<img>` can load.
 *
 * The server returns `/api/v1/product-details/images/<id>`, which is right in
 * production — the SPA and the API are the same origin, and nginx proxies /api.
 * In development they are NOT: the app is on :5173 and the API on another port,
 * so a relative path would ask Vite for an image it has never heard of.
 *
 * Deriving it from the SAME base the API client uses means the two can never
 * point at different backends.
 */
const API_ORIGIN = (import.meta.env.VITE_API_URL || "http://localhost:5000").replace(/\/+$/, "");

export const imageUrl = (path) => {
  if (!path) return null;
  // Already absolute — a future move to a CDN or object store needs no change here.
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_ORIGIN}${path}`;
};

/** Every image on a detail carries a loadable URL, so no caller builds one. */
const withImageUrls = (detail) => ({
  ...detail,
  images: (detail?.images || []).map((i) => ({ ...i, src: imageUrl(i.url) })),
  videos: detail?.videos || [],
});

export const productDetailsApi = {
  /**
   * The content for one SKU.
   *
   * A SKU with nothing recorded is NOT an error — it comes back as an empty
   * shape with `hasContent: false`, which is what most of the catalogue looks
   * like and what the panel's placeholder is for.
   */
  get: async (skuCode) => {
    const r = await api.get(`/product-details/${encodeURIComponent(skuCode)}`);
    return withImageUrls(r.data.data);
  },

  /** What the admin screen may send, so it can refuse a file before uploading. */
  limits: async () => (await api.get("/product-details/limits")).data.data,

  /** The admin list: one row per catalogue SKU with whatever content it has. */
  list: async ({ search = "", brand = "", hasContent = null, page = 1, limit = 25 } = {}) => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) qs.set("search", search);
    if (brand) qs.set("brand", brand);
    if (hasContent !== null) qs.set("hasContent", String(hasContent));
    const r = await api.get(`/product-details?${qs.toString()}`);
    return { items: r.data.items || [], pagination: r.data.pagination };
  },

  /**
   * Save the text: description and video links.
   *
   * Only the keys passed are sent, because the server distinguishes "left out"
   * (leave alone) from "sent empty" (clear it) — spreading a whole object here
   * would turn every save into a clear of whatever the caller did not know about.
   */
  save: async (skuCode, { description, videos } = {}) => {
    const body = {};
    if (description !== undefined) body.description = description;
    if (videos !== undefined) body.videos = videos;
    const r = await api.put(`/product-details/${encodeURIComponent(skuCode)}`, body);
    return withImageUrls(r.data.data);
  },

  /** Upload one or more images for a SKU. `onProgress` receives 0-100. */
  addImages: async (skuCode, files, onProgress) => {
    const form = new FormData();
    for (const file of files) form.append("images", file);
    const r = await api.post(`/product-details/${encodeURIComponent(skuCode)}/images`, form, {
      onUploadProgress: onProgress
        ? (e) => onProgress(e.total ? Math.round((e.loaded / e.total) * 100) : 0)
        : undefined,
    });
    return withImageUrls(r.data.data);
  },

  /** Swap one image for another, keeping its place in the gallery. */
  replaceImage: async (skuCode, imageId, file, onProgress) => {
    const form = new FormData();
    form.append("image", file);
    const r = await api.put(
      `/product-details/${encodeURIComponent(skuCode)}/images/${encodeURIComponent(imageId)}`,
      form,
      {
        onUploadProgress: onProgress
          ? (e) => onProgress(e.total ? Math.round((e.loaded / e.total) * 100) : 0)
          : undefined,
      },
    );
    return withImageUrls(r.data.data);
  },

  removeImage: async (skuCode, imageId) => {
    const r = await api.delete(
      `/product-details/${encodeURIComponent(skuCode)}/images/${encodeURIComponent(imageId)}`,
    );
    return withImageUrls(r.data.data);
  },

  /**
   * File a folder of photographs by reading the SKU off each filename.
   *
   * Always resolves with a per-file result rather than throwing on the first
   * bad name: a folder where three names are wrong still files the other
   * seventeen, and the caller shows exactly which three and why.
   */
  bulkImages: async (files, onProgress) => {
    const form = new FormData();
    for (const file of files) form.append("images", file);
    const r = await api.post("/product-details/images/bulk", form, {
      onUploadProgress: onProgress
        ? (e) => onProgress(e.total ? Math.round((e.loaded / e.total) * 100) : 0)
        : undefined,
    });
    return { results: r.data.results || [], summary: r.data.summary };
  },
};

export default productDetailsApi;
