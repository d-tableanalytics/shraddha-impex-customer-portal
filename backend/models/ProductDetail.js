import mongoose from 'mongoose';

/**
 * Descriptive content for a SKU — the description, photographs and videos shown
 * in the inventory slide-over.
 *
 * A SEPARATE COLLECTION, NOT MORE FIELDS ON THE PRODUCT. The product master is
 * read on every booking, every availability check and every ledger posting, and
 * its rows are what the import writes and the health projection reads. Content
 * has none of that weight: it is written by an admin at their leisure, read only
 * when someone opens a panel, and changing it must never touch a document the
 * stock path depends on. Keeping it apart also means a SKU with no content
 * costs nothing — there is simply no row.
 *
 * KEYED ON THE SKU CODE, which is what the requirement, the bulk template and
 * the admin screen all address content by. The brand is recorded alongside for
 * display and filtering, resolved from the catalogue when the row is written —
 * it is never part of the key. That mirrors the inventory-master import, which
 * also identifies a row by SKU alone and reports a code found under two brands
 * as ambiguous rather than guessing.
 */

/**
 * One stored photograph.
 *
 * The BYTES ARE NOT HERE. They live on disk under the image root, named by
 * `imageId` and nothing else — never by anything the uploader supplied, because
 * a user-controlled filename is the classic path-traversal vector. What is
 * stored here is the record: which SKU it belongs to, what it was called when
 * it arrived (data, shown in the admin list, never used as a path), and enough
 * to serve it back with the right Content-Type.
 */
const imageSchema = new mongoose.Schema(
  {
    // 32 hex characters, generated on upload. This is the on-disk name, the URL
    // segment, and the handle the admin screen deletes and replaces by.
    imageId: { type: String, required: true },
    // The extension the file is stored under — one of the accepted few, decided
    // by productDetail.rules.js and never taken from the upload verbatim.
    extension: { type: String, required: true },
    // What the browser said it was. Recorded, but the served Content-Type is
    // derived from the extension, so a lie here cannot change what is sent.
    mimeType: { type: String, default: null },
    // The name on the uploader's machine. Data: shown so an admin can tell two
    // photographs apart, never joined to a path.
    fileName: { type: String, default: null },
    size: { type: Number, default: 0 },
    // Gallery position. Explicit rather than implied by array order, so a
    // replacement can take the slot of the image it replaced.
    order: { type: Number, default: 0 },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/**
 * One video.
 *
 * Only the video id is authoritative; the URL beside it is the canonical watch
 * link rebuilt from that id. The slide-over embeds the id, never a stored URL,
 * so nothing an admin pastes can put an arbitrary page inside the portal's
 * chrome — see parseYouTubeUrl() in productDetail.rules.js.
 */
const videoSchema = new mongoose.Schema(
  {
    videoId: { type: String, required: true },
    url: { type: String, required: true },
    title: { type: String, default: null },
    // One value today. Named rather than assumed so adding Vimeo later is a
    // migration of this field, not a re-reading of every stored URL.
    provider: { type: String, enum: ['youtube'], default: 'youtube' },
    order: { type: Number, default: 0 },
  },
  { _id: false },
);

const productDetailSchema = new mongoose.Schema(
  {
    skuCode: { type: String, required: true, unique: true, trim: true },
    // Resolved from the catalogue when the row is written. Display only — the
    // SKU code is the key.
    brand: { type: String, default: null },

    // Overview, features, specifications, usage. Plain text: it is rendered as
    // text with newlines preserved, never as HTML, so a pasted description
    // cannot carry markup into the panel.
    description: { type: String, default: null },

    images: { type: [imageSchema], default: [] },
    videos: { type: [videoSchema], default: [] },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
);

// The admin list pages by recency and filters by brand.
productDetailSchema.index({ brand: 1, updatedAt: -1 });
// Serving an image resolves the row from the id in the URL, once per request.
productDetailSchema.index({ 'images.imageId': 1 });

export default mongoose.model('ProductDetail', productDetailSchema);
