import { useEffect, useState } from 'react';
import {
  ImageOff, Image as ImageIcon, ChevronLeft, ChevronRight, PlayCircle, FileText,
  Film, X, Loader2,
} from 'lucide-react';

/**
 * The descriptive half of the product slide-over: photographs, the long
 * description, and the videos.
 *
 * Split out of DetailsDrawer because the two halves answer different questions.
 * The drawer's own sections say what the business holds — stock, reservations,
 * planning inputs — and are read by staff. This says what the PRODUCT IS, and
 * is the part a customer came to look at. Keeping them apart means the content
 * can be absent, slow or empty without any of that affecting the stock figures
 * beside it.
 *
 * NOTHING HERE IS REQUIRED TO EXIST. Most of the catalogue has no content, and
 * that is the normal state rather than an error — so every section either draws
 * itself or stands down, and the gallery falls back to a placeholder rather
 * than a broken image.
 */

/**
 * The stand-in for a SKU with no photograph.
 *
 * Drawn rather than fetched: a placeholder that is itself a network request can
 * fail, and a broken image inside an "image missing" box is worse than the box.
 */
const ImagePlaceholder = ({ label = 'No product image' }) => (
  <div className="w-full aspect-4/3 rounded-xl bg-slate-100 border border-dashed border-slate-300 flex flex-col items-center justify-center gap-2 text-slate-400">
    <ImageOff size={26} />
    <span className="text-[11px] font-semibold">{label}</span>
  </div>
);

/**
 * The gallery: one large image, arrows, and a thumbnail strip.
 *
 * A carousel rather than a grid because the panel is narrow and a product photo
 * is worth showing at a size someone can actually judge.
 */
const Gallery = ({ images, skuCode }) => {
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(() => new Set());
  const [zoomed, setZoomed] = useState(false);

  // A different SKU is a different gallery — without this the panel opens on
  // image four of a product that has two.
  useEffect(() => { setIndex(0); setFailed(new Set()); }, [skuCode]);

  if (!images.length) return <ImagePlaceholder />;

  const safeIndex = Math.min(index, images.length - 1);
  const current = images[safeIndex];
  const move = (by) => setIndex((i) => (i + by + images.length) % images.length);

  // A file that has gone missing under a live row: the record survived its
  // image. Shown as the placeholder rather than the browser's broken icon.
  const broken = failed.has(current.imageId);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative group">
        {broken ? (
          <ImagePlaceholder label="This image is unavailable" />
        ) : (
          <button
            type="button"
            onClick={() => setZoomed(true)}
            className="block w-full cursor-zoom-in"
            title="Click to enlarge"
          >
            <img
              src={current.src}
              alt={`${skuCode}${current.fileName ? ` — ${current.fileName}` : ''}`}
              loading="lazy"
              onError={() => setFailed((f) => new Set(f).add(current.imageId))}
              className="w-full aspect-4/3 object-contain rounded-xl bg-slate-50 border border-slate-200"
            />
          </button>
        )}

        {images.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => move(-1)}
              aria-label="Previous image"
              className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-white/90 border border-slate-200 text-slate-600 shadow-sm hover:bg-white hover:text-primary-600 transition-colors"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => move(1)}
              aria-label="Next image"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-white/90 border border-slate-200 text-slate-600 shadow-sm hover:bg-white hover:text-primary-600 transition-colors"
            >
              <ChevronRight size={16} />
            </button>
            <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md bg-slate-900/70 text-white text-[10px] font-bold tabular-nums">
              {safeIndex + 1} / {images.length}
            </span>
          </>
        )}
      </div>

      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {images.map((image, i) => (
            <button
              key={image.imageId}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Show image ${i + 1}`}
              className={`shrink-0 w-14 h-14 rounded-lg overflow-hidden border-2 transition-colors ${
                i === safeIndex ? 'border-primary-500' : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              {failed.has(image.imageId) ? (
                <span className="w-full h-full bg-slate-100 flex items-center justify-center text-slate-300">
                  <ImageOff size={14} />
                </span>
              ) : (
                <img
                  src={image.src}
                  alt=""
                  loading="lazy"
                  onError={() => setFailed((f) => new Set(f).add(image.imageId))}
                  className="w-full h-full object-cover bg-slate-50"
                />
              )}
            </button>
          ))}
        </div>
      )}

      {/* Full-size view. The drawer is narrow by design, and a product photo
          often has the detail someone actually opened it for. */}
      {zoomed && !broken && (
        <div
          className="fixed inset-0 z-[60] bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => setZoomed(false)}
          role="presentation"
        >
          <button
            type="button"
            onClick={() => setZoomed(false)}
            aria-label="Close image"
            className="absolute top-4 right-4 p-2 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors"
          >
            <X size={18} />
          </button>
          <img
            src={current.src}
            alt={`${skuCode} enlarged`}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
          />
        </div>
      )}
    </div>
  );
};

/**
 * The videos.
 *
 * A thumbnail until it is clicked, then an inline player. Embedding every video
 * up front would load a YouTube player per link the moment the panel opens,
 * which is several hundred kilobytes each for something most viewers never
 * play — and it would set YouTube's cookies on a page nobody asked to watch a
 * video on. The `youtube-nocookie` host the server builds keeps that true even
 * once one IS played.
 */
const Videos = ({ videos }) => {
  const [playing, setPlaying] = useState(null);

  if (!videos.length) return null;

  return (
    <div className="flex flex-col gap-2">
      {videos.map((video, i) => (
        <div key={video.videoId} className="rounded-xl border border-slate-200 overflow-hidden bg-slate-50">
          {playing === video.videoId ? (
            <div className="aspect-video bg-black">
              <iframe
                src={`${video.embedUrl}?autoplay=1&rel=0`}
                title={video.title || `Video ${i + 1}`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="w-full h-full border-0"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPlaying(video.videoId)}
              className="w-full flex items-center gap-3 p-2 text-left hover:bg-white transition-colors group"
            >
              <span className="relative shrink-0 w-24 h-14 rounded-lg overflow-hidden bg-slate-200">
                <img
                  src={video.thumbnailUrl}
                  alt=""
                  loading="lazy"
                  // A thumbnail is a courtesy; the row still works without it.
                  onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                  className="w-full h-full object-cover"
                />
                <span className="absolute inset-0 flex items-center justify-center bg-slate-900/25 group-hover:bg-slate-900/10 transition-colors">
                  <PlayCircle size={22} className="text-white drop-shadow" />
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-bold text-slate-800 truncate">
                  {video.title || `Video ${i + 1}`}
                </span>
                <span className="block text-[11px] text-slate-400">Tap to play</span>
              </span>
            </button>
          )}

          {/* Always available, even while embedded: a corporate network that
              blocks the iframe still lets someone open the link. */}
          <div className="px-3 py-1.5 border-t border-slate-200/70 bg-white">
            <a
              href={video.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] font-semibold text-primary-600 hover:text-primary-700"
            >
              Open on YouTube
            </a>
          </div>
        </div>
      ))}
    </div>
  );
};

const SectionHeading = ({ icon: Icon, children }) => (
  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5">
    <Icon className="w-3.5 h-3.5 text-slate-500" />
    {children}
  </h3>
);

export const ProductContentSection = ({ skuCode, detail, loading }) => {
  const images = detail?.images ?? [];
  const videos = detail?.videos ?? [];
  const description = detail?.description ?? null;

  if (loading && !detail) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-slate-400">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-xs font-semibold">Loading product information…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <SectionHeading icon={ImageIcon}>Product images</SectionHeading>
        <Gallery images={images} skuCode={skuCode} />
      </div>

      <div>
        <SectionHeading icon={FileText}>Product description</SectionHeading>
        {description ? (
          // Rendered as TEXT with newlines preserved, never as HTML. The field
          // is admin-entered free text, and interpreting it as markup is how a
          // description becomes a script tag.
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">
            {description}
          </p>
        ) : (
          <p className="text-xs text-slate-400 italic">
            No detailed description has been added for this product yet.
          </p>
        )}
      </div>

      <div>
        <SectionHeading icon={Film}>Videos</SectionHeading>
        {videos.length > 0 ? (
          <Videos videos={videos} />
        ) : (
          <p className="text-xs text-slate-400 italic">
            No videos have been added for this product yet.
          </p>
        )}
      </div>
    </div>
  );
};

export default ProductContentSection;
