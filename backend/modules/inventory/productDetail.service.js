import fs from 'fs';

import ProductDetail from '../../models/ProductDetail.js';
import { Product } from '../../models/Product.js';
import { recordAudit } from '../../utils/auditLog.js';
import { canAccessBrand } from '../../utils/brandAccess.js';
import { imagePath, removeImageFile } from '../../middlewares/productImageUpload.js';
import {
  MAX_IMAGES_PER_SKU, MAX_VIDEOS_PER_SKU, mimeTypeFor,
  parseDescription, parseVideos, problemWithImage, skuCandidatesFromFileName,
} from './productDetail.rules.js';

/**
 * Product detail service — descriptions, photographs and videos.
 *
 * CONTENT, NOT INVENTORY. Nothing here reads or writes a balance, a movement, a
 * band or a planning input, and nothing here can create a SKU: every write is
 * refused unless the SKU is already in the catalogue. That is deliberate and it
 * is what keeps this module cheap — a wrong description is a wrong description,
 * never a wrong stock figure.
 *
 * The bytes of an image live on disk under the image root; this service owns
 * the record of them and is the only thing that puts the two back together.
 * When the two can disagree — a file written but its row not saved, a row
 * deleted but its file left behind — the code below always fails towards the
 * ORPHANED FILE rather than the broken reference: a file nothing points at
 * wastes a few hundred kilobytes, while a row pointing at a file that is not
 * there is a broken image in front of a customer.
 */

const fail = (message, status = 400, code = 'PRODUCT_DETAIL_ERROR') => {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
};

/** A well-formed page with nothing on it — for a filter that excludes everything. */
const emptyPage = (page, limit) => ({
  items: [],
  pagination: { total: 0, page: Number(page) || 1, limit: Number(limit) || 25, pages: 1 },
});

/**
 * Find the SKU in the catalogue, or refuse.
 *
 * Content is only ever attached to a product that exists. A description saved
 * against a mistyped code would sit in the collection forever, invisible,
 * because no inventory row would ever ask for it.
 *
 * Matched case-insensitively but ANCHORED and escaped, so a code with regex
 * metacharacters in it — and SKU codes are full of dashes and dots — matches
 * literally rather than as a pattern.
 */
const resolveSku = async (rawSkuCode) => {
  const skuCode = String(rawSkuCode ?? '').trim();
  if (!skuCode) fail('A SKU code is required.', 400);
  if (skuCode.length > 64) fail('That is not a SKU code.', 400);

  const exact = await Product.findOne({ skuCode }, 'skuCode brand description').lean();
  if (exact) return { skuCode: exact.skuCode, brand: exact.brand, product: exact };

  const escaped = skuCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const loose = await Product.findOne(
    { skuCode: { $regex: `^${escaped}$`, $options: 'i' } },
    'skuCode brand description',
  ).lean();
  if (!loose) fail(`${skuCode} is not in the catalogue.`, 404, 'SKU_NOT_FOUND');

  // The catalogue's spelling wins, so content is always filed under the code
  // the inventory screens actually show.
  return { skuCode: loose.skuCode, brand: loose.brand, product: loose };
};

/** The shape every endpoint returns, so the frontend has one thing to read. */
const shape = (detail, resolved = null) => ({
  skuCode: detail?.skuCode ?? resolved?.skuCode ?? null,
  brand: detail?.brand ?? resolved?.brand ?? null,
  description: detail?.description ?? null,
  images: [...(detail?.images ?? [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((i) => ({
      imageId: i.imageId,
      // The URL the browser loads. Built here rather than in the browser so the
      // route can move without every caller learning about it.
      url: `/api/v1/product-details/images/${i.imageId}`,
      fileName: i.fileName,
      size: i.size,
      order: i.order ?? 0,
      uploadedAt: i.uploadedAt,
    })),
  videos: [...(detail?.videos ?? [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((v) => ({
      videoId: v.videoId,
      url: v.url,
      title: v.title,
      provider: v.provider,
      order: v.order ?? 0,
      // Built from the id, never from a stored URL — the id is the only part
      // that has been validated as a YouTube video.
      embedUrl: `https://www.youtube-nocookie.com/embed/${v.videoId}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
    })),
  updatedAt: detail?.updatedAt ?? null,
  // Lets the slide-over decide between a gallery and a placeholder without
  // counting arrays itself.
  hasContent: Boolean(detail?.description || detail?.images?.length || detail?.videos?.length),
});

/**
 * What to show in the slide-over for one SKU.
 *
 * A SKU with no content is NOT an error — it is the normal state of most of the
 * catalogue, and the panel shows a placeholder for it. So this returns the empty
 * shape rather than a 404, and the only 404 is a SKU that does not exist.
 *
 * Open to every signed-in user, customers included: this is what the product IS,
 * and it is the reason the panel exists. Brand isolation is applied here rather
 * than on the route, because only this function knows which brand the SKU turned
 * out to belong to — and a brand the user cannot see reports as NOT IN THE
 * CATALOGUE rather than as forbidden, so the endpoint never confirms that a SKU
 * they may not see exists.
 */
export const getProductDetail = async (rawSkuCode, user = null) => {
  const resolved = await resolveSku(rawSkuCode);

  if (user && resolved.brand && !canAccessBrand(user, resolved.brand)) {
    fail(`${resolved.skuCode} is not in the catalogue.`, 404, 'SKU_NOT_FOUND');
  }

  const detail = await ProductDetail.findOne({ skuCode: resolved.skuCode }).lean();
  return shape(detail, resolved);
};

/**
 * Resolve an image id to something the serving route can stream.
 *
 * The Content-Type comes from the EXTENSION recorded on the document, not from
 * whatever the uploader claimed the file was — a stored mime type is a record
 * of what someone said, and serving on that basis is how an "image" gets served
 * as HTML.
 */
export const findImage = async (rawImageId) => {
  const imageId = String(rawImageId ?? '').trim();
  // 32 hex characters and nothing else — checked before it reaches the query,
  // so a crafted id is refused rather than filtered on.
  if (!/^[0-9a-f]{32}$/.test(imageId)) fail('Not an image id.', 404, 'NOT_FOUND');

  const detail = await ProductDetail.findOne(
    { 'images.imageId': imageId },
    { skuCode: 1, images: { $elemMatch: { imageId } } },
  ).lean();

  const image = detail?.images?.[0];
  if (!image) fail('Image not found.', 404, 'NOT_FOUND');

  return {
    path: imagePath(image.imageId, image.extension),
    contentType: mimeTypeFor(image.extension),
    fileName: image.fileName || `${image.imageId}${image.extension}`,
    skuCode: detail.skuCode,
  };
};

/** Load-or-create the row for a SKU that is known to exist. */
const openDetail = async (resolved) => {
  const existing = await ProductDetail.findOne({ skuCode: resolved.skuCode });
  if (existing) {
    // The catalogue may have moved the SKU between brands since the row was
    // written; the display copy follows it.
    if (resolved.brand && existing.brand !== resolved.brand) existing.brand = resolved.brand;
    return existing;
  }
  return new ProductDetail({ skuCode: resolved.skuCode, brand: resolved.brand });
};

/**
 * Save the text side of a SKU's content — description and video links.
 *
 * Images are NOT touched here. They arrive as files on their own endpoints, and
 * folding them into this call would mean a form that saves a description also
 * had to carry every existing image back or lose them.
 *
 * A field left OUT of the payload is left alone; a field sent EMPTY is cleared.
 * That distinction is the only way to offer "remove the description" and
 * "update only the videos" through one endpoint.
 */
export const saveProductDetail = async ({ skuCode, description, videos, actor, req }) => {
  const resolved = await resolveSku(skuCode);
  const detail = await openDetail(resolved);

  const changed = [];

  if (description !== undefined) {
    const parsed = parseDescription(description);
    if (parsed.problem) fail(parsed.problem, 400, 'INVALID_DESCRIPTION');
    if (detail.description !== parsed.value) changed.push('description');
    detail.description = parsed.value;
  }

  if (videos !== undefined) {
    if (!Array.isArray(videos)) fail('Videos must be a list of links.', 400);
    const { values, problems } = parseVideos(videos);
    // Every bad link is reported at once. One per save is a round trip per
    // typo, and these are pasted in threes.
    if (problems.length) fail(problems.join(' '), 400, 'INVALID_VIDEO');
    if (values.length > MAX_VIDEOS_PER_SKU) {
      fail(`A SKU may have at most ${MAX_VIDEOS_PER_SKU} videos.`, 400);
    }
    changed.push('videos');
    detail.videos = values;
  }

  detail.updatedBy = actor?._id ?? null;
  await detail.save();

  await recordAudit(
    actor,
    'Product Details Updated',
    `Product details saved for ${resolved.skuCode}`
    + (changed.length ? ` (${changed.join(', ')}).` : ' (no change).'),
    req,
    { meta: { skuCode: resolved.skuCode, brand: resolved.brand, changed, videos: detail.videos.length } },
  );

  return shape(detail.toObject(), resolved);
};

/**
 * Record images multer has already written to disk.
 *
 * The files exist by the time this runs — that is what multer's disk storage
 * does — so every path out of here either records them or deletes them. A file
 * left on disk with no row is invisible and unrecoverable.
 */
export const addProductImages = async ({ skuCode, files, actor, req }) => {
  const uploaded = Array.isArray(files) ? files : [];
  if (uploaded.length === 0) fail('No image was uploaded.', 400, 'NO_FILE');

  const cleanUp = async () => {
    for (const f of uploaded) await fs.promises.unlink(f.path).catch(() => {});
  };

  let resolved;
  try {
    resolved = await resolveSku(skuCode);
  } catch (error) {
    await cleanUp();
    throw error;
  }

  const detail = await openDetail(resolved);

  if (detail.images.length + uploaded.length > MAX_IMAGES_PER_SKU) {
    await cleanUp();
    fail(
      `${resolved.skuCode} already has ${detail.images.length} image(s); the limit is `
      + `${MAX_IMAGES_PER_SKU}. Remove some before adding ${uploaded.length} more.`,
      400, 'TOO_MANY_IMAGES',
    );
  }

  // Re-checked against the real size on disk. The filter that ran before the
  // upload only knew the declared type; this is the first point at which the
  // actual bytes are known.
  for (const f of uploaded) {
    const problem = problemWithImage({ mimeType: f.mimetype, originalName: f.originalname, size: f.size });
    if (problem) {
      await cleanUp();
      fail(problem, 400, 'UNSUPPORTED_IMAGE_TYPE');
    }
  }

  let nextOrder = detail.images.reduce((max, i) => Math.max(max, i.order ?? 0), -1) + 1;
  const added = uploaded.map((f) => ({
    imageId: f.imageId,
    extension: f.storedExtension,
    mimeType: f.mimetype ?? null,
    fileName: f.originalname ?? null,
    size: f.size ?? 0,
    order: nextOrder++,
    uploadedBy: actor?._id ?? null,
    uploadedAt: new Date(),
  }));

  detail.images.push(...added);
  detail.updatedBy = actor?._id ?? null;

  try {
    await detail.save();
  } catch (error) {
    // The row did not land, so the files it would have referenced must not stay.
    await cleanUp();
    throw error;
  }

  await recordAudit(
    actor,
    'Product Images Uploaded',
    `${added.length} image(s) uploaded for ${resolved.skuCode}.`,
    req,
    { meta: { skuCode: resolved.skuCode, imageIds: added.map((a) => a.imageId) } },
  );

  return shape(detail.toObject(), resolved);
};

/**
 * Swap one image for another, keeping its place in the gallery.
 *
 * "Replace" rather than "delete then add" because the order matters: the first
 * image is the one the inventory row and the panel lead with, and a replacement
 * that landed at the end of the gallery would quietly demote it.
 */
export const replaceProductImage = async ({ skuCode, imageId, file, actor, req }) => {
  if (!file) fail('No image was uploaded.', 400, 'NO_FILE');

  const discard = () => fs.promises.unlink(file.path).catch(() => {});

  let resolved;
  try {
    resolved = await resolveSku(skuCode);
  } catch (error) {
    await discard();
    throw error;
  }

  const detail = await ProductDetail.findOne({ skuCode: resolved.skuCode });
  const existing = detail?.images?.find((i) => i.imageId === imageId);
  if (!existing) {
    await discard();
    fail(`That image does not belong to ${resolved.skuCode}.`, 404, 'NOT_FOUND');
  }

  const problem = problemWithImage({ mimeType: file.mimetype, originalName: file.originalname, size: file.size });
  if (problem) {
    await discard();
    fail(problem, 400, 'UNSUPPORTED_IMAGE_TYPE');
  }

  const replaced = { imageId: existing.imageId, extension: existing.extension };

  existing.imageId = file.imageId;
  existing.extension = file.storedExtension;
  existing.mimeType = file.mimetype ?? null;
  existing.fileName = file.originalname ?? null;
  existing.size = file.size ?? 0;
  existing.uploadedBy = actor?._id ?? null;
  existing.uploadedAt = new Date();
  detail.updatedBy = actor?._id ?? null;

  try {
    await detail.save();
  } catch (error) {
    await discard();
    throw error;
  }

  // Only after the row is safely pointing at the new file. The other order
  // leaves a live row referencing a file that has just been deleted.
  await removeImageFile(replaced.imageId, replaced.extension);

  await recordAudit(
    actor,
    'Product Images Updated',
    `An image was replaced for ${resolved.skuCode}.`,
    req,
    { meta: { skuCode: resolved.skuCode, removed: replaced.imageId, added: file.imageId } },
  );

  return shape(detail.toObject(), resolved);
};

export const removeProductImage = async ({ skuCode, imageId, actor, req }) => {
  const resolved = await resolveSku(skuCode);
  const detail = await ProductDetail.findOne({ skuCode: resolved.skuCode });
  const existing = detail?.images?.find((i) => i.imageId === imageId);
  if (!existing) fail(`That image does not belong to ${resolved.skuCode}.`, 404, 'NOT_FOUND');

  const removed = { imageId: existing.imageId, extension: existing.extension };
  detail.images = detail.images.filter((i) => i.imageId !== imageId);
  // Re-numbered so the gallery has no gaps and the next upload lands after the
  // last image rather than into a hole.
  detail.images.forEach((image, index) => { image.order = index; });
  detail.updatedBy = actor?._id ?? null;
  await detail.save();

  await removeImageFile(removed.imageId, removed.extension);

  await recordAudit(
    actor,
    'Product Images Updated',
    `An image was removed from ${resolved.skuCode}.`,
    req,
    { meta: { skuCode: resolved.skuCode, removed: removed.imageId } },
  );

  return shape(detail.toObject(), resolved);
};

/**
 * Put a folder of photographs where they belong, by reading the SKU off each
 * filename.
 *
 * `14405M-10.jpg` files against 14405M-10; `14405M-10_2.jpg` and
 * `14405M-10 (1).png` file against the same SKU as second and third images.
 * That convention exists because it is how photographs actually come off a
 * camera roll after someone has renamed them, and because the alternative —
 * asking an admin to attach twelve files one SKU at a time — is the thing this
 * endpoint is for avoiding.
 *
 * Every file is reported individually. A folder where three names are wrong
 * must still file the other seventeen, or the admin is left re-uploading
 * everything to fix three.
 */
export const bulkAddProductImages = async ({ files, actor, req }) => {
  const uploaded = Array.isArray(files) ? files : [];
  if (uploaded.length === 0) fail('No images were uploaded.', 400, 'NO_FILE');

  const results = [];
  const bySku = new Map();

  // ── Which candidate names an actual SKU ────────────────────────────────
  // Resolved in ONE query for the whole batch rather than per file. Each
  // filename offers the whole name first and the de-sequenced form second (see
  // skuCandidatesFromFileName), and the FIRST that the catalogue knows wins —
  // so "14405M-10.jpg" files against 14405M-10 rather than 14405M, and
  // "14405M-10_2.jpg" still finds 14405M-10 when the whole name does not exist.
  const perFile = uploaded.map((file) => ({
    file, candidates: skuCandidatesFromFileName(file.originalname),
  }));
  const allCandidates = [...new Set(perFile.flatMap((f) => f.candidates))];

  // Matched case-insensitively, because a filename's case is whatever the
  // camera or the person renaming it happened to use. The catalogue's spelling
  // is what gets stored.
  const known = new Map();
  if (allCandidates.length) {
    const rows = await Product.find(
      {
        $or: allCandidates.map((c) => ({
          skuCode: { $regex: `^${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
        })),
      },
      'skuCode',
    ).lean();
    for (const row of rows) known.set(row.skuCode.toLowerCase(), row.skuCode);
  }

  for (const { file, candidates } of perFile) {
    const resolved = candidates.map((c) => known.get(c.toLowerCase())).find(Boolean) ?? null;

    if (!resolved) {
      results.push({
        fileName: file.originalname,
        ok: false,
        reason: candidates.length
          ? `No SKU named "${candidates[0]}" is in the catalogue.`
          : 'The filename does not name a SKU.',
      });
      await fs.promises.unlink(file.path).catch(() => {});
      continue;
    }

    if (!bySku.has(resolved)) bySku.set(resolved, []);
    bySku.get(resolved).push(file);
  }

  // ── File each group against its SKU ────────────────────────────────────
  for (const [skuCode, group] of bySku) {
    try {
      // Deliberately one call per SKU rather than one per file: the per-SKU
      // limit and the ordering are decided against the whole group, so ten
      // photographs of one part are accepted or refused together.
      const detail = await addProductImages({ skuCode, files: group, actor, req });
      for (const f of group) {
        results.push({ fileName: f.originalname, ok: true, skuCode: detail.skuCode });
      }
    } catch (error) {
      // addProductImages() has already deleted this group's files.
      for (const f of group) {
        results.push({ fileName: f.originalname, ok: false, reason: error.message });
      }
    }
  }

  const applied = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  await recordAudit(
    actor,
    'Product Images Uploaded',
    `Bulk image upload: ${applied.length} of ${results.length} file(s) filed against a SKU.`,
    req,
    { meta: { applied: applied.length, failed: failed.length, skus: [...new Set(applied.map((a) => a.skuCode))] } },
  );

  return {
    results,
    summary: {
      total: results.length,
      applied: applied.length,
      failed: failed.length,
      skus: [...new Set(applied.map((a) => a.skuCode))].length,
    },
  };
};

/**
 * The admin list: every SKU in the catalogue with whatever content it has.
 *
 * Driven from the PRODUCT side, not from the content side. An admin looking for
 * a SKU to describe needs to find the ones with nothing on them, and a list of
 * existing content rows can only ever show what has already been done.
 */
export const listProductDetails = async ({
  search = '', brand = '', hasContent = null, page = 1, limit = 25, brands = null,
} = {}) => {
  const query = {};

  // Brand isolation first, then the requested filter NARROWS it — never
  // replaces it. Assigning the filter over the isolation is how a brand a user
  // may not see ends up on their screen.
  if (Array.isArray(brands)) query.brand = { $in: brands };
  if (brand) {
    if (Array.isArray(brands) && !brands.includes(brand)) return emptyPage(page, limit);
    query.brand = brand;
  }

  const term = String(search ?? '').trim();
  if (term) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Prefix-anchored so the index on { brand, skuCode } can serve it.
    query.$or = [
      { skuCode: { $regex: `^${escaped}`, $options: 'i' } },
      { msilCode: { $regex: `^${escaped}`, $options: 'i' } },
    ];
  }

  /**
   * "Described" / "Not described" is answered by listing the SKUs that HAVE a
   * content row and constraining the product query with it.
   *
   * A $lookup would be the tidy way and the wrong one: it would join the whole
   * catalogue on every page of a list that is browsed constantly. The set of
   * described SKUs is small by definition — it is the work an admin has done so
   * far — so pulling the codes once and filtering on them is both cheaper and
   * bounded by that work rather than by the catalogue.
   */
  if (hasContent !== null) {
    const described = await ProductDetail.find(
      {
        $or: [
          { description: { $nin: [null, ''] } },
          { 'images.0': { $exists: true } },
          { 'videos.0': { $exists: true } },
        ],
      },
      'skuCode',
    ).lean();
    const codes = described.map((d) => d.skuCode);
    query.skuCode = hasContent ? { $in: codes } : { $nin: codes };
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);

  const [products, total] = await Promise.all([
    Product.find(query, 'skuCode brand msilCode description')
      .sort({ brand: 1, skuCode: 1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    Product.countDocuments(query),
  ]);

  // One query for the page's content rather than one per row.
  const details = await ProductDetail.find(
    { skuCode: { $in: products.map((p) => p.skuCode) } },
    'skuCode description images videos updatedAt',
  ).lean();
  const byCode = new Map(details.map((d) => [d.skuCode, d]));

  return {
    items: products.map((p) => {
      const detail = byCode.get(p.skuCode);
      return {
        skuCode: p.skuCode,
        brand: p.brand,
        msilCode: p.msilCode ?? null,
        // The catalogue's own short description, so a SKU with no content row
        // still shows what the master knows about it.
        catalogueDescription: p.description ?? null,
        hasDescription: Boolean(detail?.description),
        imageCount: detail?.images?.length ?? 0,
        videoCount: detail?.videos?.length ?? 0,
        updatedAt: detail?.updatedAt ?? null,
      };
    }),
    pagination: {
      total, page: safePage, limit: safeLimit, pages: Math.ceil(total / safeLimit) || 1,
    },
  };
};

export default {
  getProductDetail, findImage, saveProductDetail,
  addProductImages, replaceProductImage, removeProductImage, bulkAddProductImages,
  listProductDetails,
};
