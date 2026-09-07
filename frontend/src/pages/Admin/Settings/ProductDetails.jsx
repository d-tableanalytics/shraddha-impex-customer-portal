import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  Boxes, Search, ImagePlus, Trash2, RefreshCw, Save, Loader2, Film, Plus, X,
  FileText, Image as ImageIcon, Upload, CheckCircle2, AlertTriangle, ImageOff,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { Card, CardContent } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Pagination } from '../../../components/ui/Pagination';
import { TableSkeleton } from '../../../components/ui/TableSkeleton';
import { PageHeader } from '../../../components/common/PageHeader';
import { productDetailsApi } from '../../../services/productDetails';
import { useUserStore } from '../../../store/userStore';
import { allowedBrands } from '../../../utils/brandAccess';
import { hasPermission, PERMISSIONS } from '../../../utils/permissions';

/**
 * Admin → Product Details.
 *
 * Where the descriptions, photographs and videos that the inventory
 * slide-over shows are maintained.
 *
 * THE LIST IS DRIVEN FROM THE CATALOGUE, not from the content. An admin coming
 * here is looking for the SKUs that have nothing on them yet, and a list built
 * from existing content rows can only ever show the work already done. So every
 * catalogue SKU appears, with what it currently has beside it.
 *
 * EVERY WRITE IS ITS OWN REQUEST, and lands immediately. Images especially:
 * they are files, they upload one batch at a time, and holding them in the
 * browser until a Save button is pressed would mean a browser crash losing an
 * upload that had already finished. Only the text has a Save button, because
 * only the text is edited rather than transferred.
 */

const inputCls =
  'w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none '
  + 'focus:border-primary-500 focus:ring-1 focus:ring-primary-500';

const PAGE_SIZE = 20;

const fmtBytes = (n) => {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

/* ── The gallery editor ───────────────────────────────────────────────────── */

/**
 * Uploading, previewing, replacing and removing one SKU's photographs.
 *
 * Each action returns the WHOLE detail from the server and the caller adopts
 * it, rather than the screen patching its own copy. A gallery is ordered, and
 * an optimistic local edit that guesses the new order wrong shows the admin a
 * layout the customer will not get.
 */
const ImageManager = ({ skuCode, detail, limits, onChanged }) => {
  const addInput = useRef(null);
  const replaceInput = useRef(null);
  const [replacing, setReplacing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  const images = detail?.images ?? [];
  const remaining = (limits?.maxImagesPerSku ?? 12) - images.length;

  /**
   * Refuse what the server would refuse, before spending the upload on it.
   *
   * The server checks all of this again — this is a courtesy, not the control.
   * Its value is that a 12 MB photo fails instantly instead of after a minute
   * of uploading on a site connection.
   */
  const problemWith = (file) => {
    const ext = (file.name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
    const allowed = limits?.allowedImageExtensions ?? ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];
    if (!allowed.includes(ext)) {
      return `"${file.name}" is not an image this accepts (${allowed.join(', ')}).`;
    }
    const max = limits?.maxImageBytes ?? 5 * 1024 * 1024;
    if (file.size > max) {
      return `"${file.name}" is ${fmtBytes(file.size)}. The limit is ${fmtBytes(max)}.`;
    }
    return null;
  };

  const runUpload = async (work) => {
    setBusy(true);
    setProgress(0);
    try {
      const updated = await work();
      onChanged(updated);
      return true;
    } catch (err) {
      toast.error(err.response?.data?.message || 'The upload failed.');
      return false;
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  const handleAdd = async (event) => {
    const files = [...(event.target.files || [])];
    // Cleared immediately so choosing the same file twice in a row still fires
    // a change event.
    event.target.value = '';
    if (!files.length) return;

    const perRequest = limits?.maxImagesPerRequest ?? 5;
    if (files.length > perRequest) {
      toast.error(`Add at most ${perRequest} images at a time.`);
      return;
    }
    if (files.length > remaining) {
      toast.error(`${skuCode} can hold ${remaining} more image(s).`);
      return;
    }
    for (const file of files) {
      const problem = problemWith(file);
      if (problem) { toast.error(problem); return; }
    }

    const ok = await runUpload(() => productDetailsApi.addImages(skuCode, files, setProgress));
    if (ok) toast.success(`${files.length} image(s) uploaded.`);
  };

  const handleReplace = async (event) => {
    const file = (event.target.files || [])[0];
    event.target.value = '';
    const imageId = replacing;
    setReplacing(null);
    if (!file || !imageId) return;

    const problem = problemWith(file);
    if (problem) { toast.error(problem); return; }

    const ok = await runUpload(() => productDetailsApi.replaceImage(skuCode, imageId, file, setProgress));
    if (ok) toast.success('Image replaced.');
  };

  const handleRemove = async (imageId, fileName) => {
    // Deleting a file is not undoable, and the thumbnails are small enough that
    // hitting the wrong one is easy.
    if (!window.confirm(`Remove ${fileName || 'this image'} from ${skuCode}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      onChanged(await productDetailsApi.removeImage(skuCode, imageId));
      toast.success('Image removed.');
    } catch (err) {
      toast.error(err.response?.data?.message || 'The image could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
          <ImageIcon size={13} />
          Product images
          <span className="font-semibold text-slate-400 normal-case tracking-normal">
            ({images.length} of {limits?.maxImagesPerSku ?? 12})
          </span>
        </h4>
        <Button
          size="xs"
          className="ml-auto"
          onClick={() => addInput.current?.click()}
          disabled={busy || remaining <= 0}
          title={remaining <= 0 ? 'This SKU has reached its image limit.' : undefined}
        >
          <ImagePlus size={13} className="mr-1.5" />Add images
        </Button>
        <input
          ref={addInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={handleAdd}
        />
        <input ref={replaceInput} type="file" accept="image/*" hidden onChange={handleReplace} />
      </div>

      {busy && progress > 0 && (
        <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
          <div className="h-full bg-primary-600 transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}

      {images.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 py-8 flex flex-col items-center gap-2 text-slate-400">
          <ImageOff size={22} />
          <span className="text-xs font-semibold">No images yet</span>
          <span className="text-[11px]">
            The slide-over shows a placeholder until one is uploaded.
          </span>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {images.map((image, i) => (
            <div key={image.imageId} className="rounded-xl border border-slate-200 overflow-hidden bg-white">
              <div className="relative aspect-4/3 bg-slate-50">
                <img
                  src={image.src}
                  alt={image.fileName || `${skuCode} image ${i + 1}`}
                  loading="lazy"
                  className="w-full h-full object-contain"
                />
                {i === 0 && (
                  // The first image is the one the panel leads with, so which
                  // one that is has to be visible here.
                  <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-primary-600 text-white text-[9px] font-bold uppercase tracking-wide">
                    Main
                  </span>
                )}
              </div>
              <div className="p-2 flex flex-col gap-1.5">
                <span className="text-[10px] text-slate-400 truncate" title={image.fileName || ''}>
                  {image.fileName || image.imageId}
                </span>
                <div className="flex gap-1.5">
                  <Button
                    size="xs"
                    variant="secondary"
                    className="flex-1"
                    disabled={busy}
                    onClick={() => { setReplacing(image.imageId); replaceInput.current?.click(); }}
                  >
                    <RefreshCw size={11} className="mr-1" />Replace
                  </Button>
                  <Button
                    size="xs"
                    variant="danger"
                    disabled={busy}
                    onClick={() => handleRemove(image.imageId, image.fileName)}
                    aria-label={`Remove ${image.fileName || 'image'}`}
                  >
                    <Trash2 size={11} />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-slate-400">
        {(limits?.allowedImageExtensions ?? []).join(', ')} up to {fmtBytes(limits?.maxImageBytes)} each,
        {' '}{limits?.maxImagesPerRequest ?? 5} at a time. The first image is the one shown first.
      </p>
    </div>
  );
};

/* ── The SKU editor ───────────────────────────────────────────────────────── */

const DetailEditor = ({ skuCode, limits, onSaved, onClose }) => {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [description, setDescription] = useState('');
  const [videos, setVideos] = useState([]);

  // What the server last confirmed, so "unsaved changes" is a comparison rather
  // than a flag someone has to remember to set.
  const [baseline, setBaseline] = useState({ description: '', videos: [] });

  const adopt = useCallback((fetched) => {
    setDetail(fetched);
    const nextVideos = (fetched?.videos ?? []).map((v) => ({ url: v.url, title: v.title ?? '' }));
    setDescription(fetched?.description ?? '');
    setVideos(nextVideos);
    setBaseline({ description: fetched?.description ?? '', videos: nextVideos });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    productDetailsApi
      .get(skuCode)
      .then((fetched) => { if (!cancelled) adopt(fetched); })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err.response?.data?.message || 'Could not load this product.');
        onClose?.();
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [skuCode, adopt, onClose]);

  const dirty = useMemo(() => (
    description !== baseline.description
    || JSON.stringify(videos) !== JSON.stringify(baseline.videos)
  ), [description, videos, baseline]);

  const maxVideos = limits?.maxVideosPerSku ?? 6;
  const maxDescription = limits?.maxDescriptionLength ?? 8000;

  const setVideo = (index, patch) =>
    setVideos((list) => list.map((v, i) => (i === index ? { ...v, ...patch } : v)));

  const handleSave = async () => {
    if (description.length > maxDescription) {
      toast.error(`The description is ${description.length} characters; the limit is ${maxDescription}.`);
      return;
    }

    setSaving(true);
    try {
      // Blank rows are dropped rather than sent: an admin who added a row and
      // then thought better of it means "no video", not "a video with no link",
      // and the server would reject the latter.
      const payload = videos
        .filter((v) => String(v.url ?? '').trim() !== '')
        .map((v) => ({ url: v.url.trim(), title: String(v.title ?? '').trim() }));

      const updated = await productDetailsApi.save(skuCode, { description, videos: payload });
      adopt(updated);
      onSaved?.(updated);
      toast.success(`Product details saved for ${skuCode}.`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'The product details could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (dirty && !window.confirm('Close without saving? The description and video changes will be lost.')) return;
    onClose?.();
  };

  return (
    <Modal isOpen onClose={handleClose} size="xl" title={`Product details — ${skuCode}`}>
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-slate-400">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-sm font-semibold">Loading…</span>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {/* ── Description ────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                <FileText size={13} />Product description
              </h4>
              <span className={`ml-auto text-[11px] font-semibold tabular-nums ${
                description.length > maxDescription ? 'text-error-600' : 'text-slate-400'
              }`}
              >
                {description.length.toLocaleString()} / {maxDescription.toLocaleString()}
              </span>
            </div>
            <textarea
              rows={8}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={'Overview: what the product is.\nFeatures: what it does.\n'
                + 'Specifications: sizes, materials, contents.\nUsage: how it is meant to be used.'}
              className={`${inputCls} font-normal leading-relaxed resize-y`}
            />
            <p className="text-[11px] text-slate-400">
              Shown as plain text with your line breaks preserved. Leave it empty to remove the
              description.
            </p>
          </div>

          {/* ── Images ─────────────────────────────────────────────────── */}
          <div className="border-t border-slate-100 pt-5">
            <ImageManager
              skuCode={skuCode}
              detail={detail}
              limits={limits}
              // Images save the moment they upload, so the parent list has to
              // learn about them without waiting for the text's Save button.
              onChanged={(updated) => { setDetail(updated); onSaved?.(updated); }}
            />
          </div>

          {/* ── Videos ─────────────────────────────────────────────────── */}
          <div className="border-t border-slate-100 pt-5 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                <Film size={13} />Videos
                <span className="font-semibold text-slate-400 normal-case tracking-normal">
                  ({videos.length} of {maxVideos})
                </span>
              </h4>
              <Button
                size="xs"
                variant="secondary"
                className="ml-auto"
                disabled={videos.length >= maxVideos}
                onClick={() => setVideos((list) => [...list, { url: '', title: '' }])}
              >
                <Plus size={12} className="mr-1" />Add link
              </Button>
            </div>

            {videos.length === 0 ? (
              <p className="text-xs text-slate-400 italic py-2">
                No videos yet. YouTube links only — they play inside the product panel.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {videos.map((video, i) => (
                  // Index-keyed on purpose: the rows have no identity until they
                  // are saved, and two blank rows are genuinely the same thing.
                  // eslint-disable-next-line react/no-array-index-key
                  <div key={i} className="flex flex-wrap items-start gap-2 p-2 rounded-lg border border-slate-200 bg-slate-50/60">
                    <div className="flex-1 min-w-52 flex flex-col gap-1.5">
                      <input
                        type="url"
                        value={video.url}
                        onChange={(e) => setVideo(i, { url: e.target.value })}
                        placeholder="https://www.youtube.com/watch?v=…"
                        className={inputCls}
                        aria-label={`Video ${i + 1} link`}
                      />
                      <input
                        type="text"
                        value={video.title}
                        onChange={(e) => setVideo(i, { title: e.target.value })}
                        placeholder="Title (optional) — e.g. Product overview"
                        className={`${inputCls} text-xs`}
                        aria-label={`Video ${i + 1} title`}
                      />
                    </div>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setVideos((list) => list.filter((_, j) => j !== i))}
                      aria-label={`Remove video ${i + 1}`}
                    >
                      <X size={14} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] text-slate-400">
              Only YouTube links are accepted — watch, share, embed and Shorts URLs all work.
              Saved with the description.
            </p>
          </div>

          {/* ── Footer ─────────────────────────────────────────────────── */}
          <div className="flex items-center gap-2 pt-1 border-t border-slate-100">
            <span className="text-[11px] text-slate-400">
              {dirty ? 'Unsaved description or video changes.' : 'Images save as they upload.'}
            </span>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" onClick={handleClose} disabled={saving}>
                Close
              </Button>
              <Button size="sm" onClick={handleSave} loading={saving} disabled={!dirty}>
                {!saving && <Save size={14} className="mr-2" />}Save details
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
};

/* ── Bulk image upload ────────────────────────────────────────────────────── */

/**
 * File a folder of photographs by reading the SKU off each filename.
 *
 * Deliberately separate from the spreadsheet import: a spreadsheet carries text
 * and cannot carry a photograph, so images need their own way in when there are
 * more of them than the one-SKU-at-a-time editor is worth opening for.
 */
const BulkImageModal = ({ limits, onClose, onDone }) => {
  const input = useRef(null);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState(null);

  const maxFiles = limits?.maxBulkImagesPerRequest ?? 20;

  const handleUpload = async () => {
    if (!files.length) return;
    setBusy(true);
    setProgress(0);
    try {
      const { results: rows, summary } = await productDetailsApi.bulkImages(files, setProgress);
      setResults({ rows, summary });
      setFiles([]);
      if (summary.applied) toast.success(`${summary.applied} image(s) filed against ${summary.skus} SKU(s).`);
      if (summary.failed) toast.error(`${summary.failed} file(s) could not be matched.`);
      onDone?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'The bulk upload failed.');
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  return (
    <Modal isOpen onClose={busy ? () => {} : onClose} size="lg" title="Bulk image upload">
      <div className="flex flex-col gap-4">
        <div className="p-3 rounded-lg bg-primary-50 border border-primary-200 text-xs text-primary-900 leading-relaxed">
          <strong>Name each file after its SKU.</strong> <code>14405M-10.jpg</code> files against
          {' '}14405M-10. For a second or third photograph of the same SKU, add a number:
          {' '}<code>14405M-10_2.jpg</code>, <code>14405M-10 (3).png</code>. Anything the catalogue
          does not recognise is reported and skipped — the rest still upload.
        </div>

        <div>
          <Button variant="secondary" size="sm" onClick={() => input.current?.click()} disabled={busy}>
            <Upload size={14} className="mr-2" />Choose images
          </Button>
          <input
            ref={input}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const chosen = [...(e.target.files || [])];
              e.target.value = '';
              if (chosen.length > maxFiles) {
                toast.error(`Upload at most ${maxFiles} images at a time.`);
                return;
              }
              setFiles(chosen);
              setResults(null);
            }}
          />
          <span className="ml-3 text-[11px] text-slate-400">
            Up to {maxFiles} files, {fmtBytes(limits?.maxImageBytes)} each.
          </span>
        </div>

        {files.length > 0 && (
          <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
            {files.map((file) => (
              <div key={file.name} className="px-3 py-1.5 flex items-center gap-2 text-xs">
                <ImageIcon size={12} className="text-slate-400 shrink-0" />
                <span className="flex-1 truncate text-slate-700">{file.name}</span>
                <span className="text-slate-400 tabular-nums">{fmtBytes(file.size)}</span>
              </div>
            ))}
          </div>
        )}

        {busy && (
          <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-primary-600 transition-all" style={{ width: `${progress}%` }} />
          </div>
        )}

        {results && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-3 text-xs font-semibold">
              <span className="text-success-700 flex items-center gap-1">
                <CheckCircle2 size={13} />{results.summary.applied} filed
              </span>
              {results.summary.failed > 0 && (
                <span className="text-error-600 flex items-center gap-1">
                  <AlertTriangle size={13} />{results.summary.failed} skipped
                </span>
              )}
              <span className="text-slate-500">{results.summary.skus} SKU(s) updated</span>
            </div>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
              {results.rows.map((row, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <div key={`${row.fileName}-${i}`} className="px-3 py-1.5 flex items-start gap-2 text-xs">
                  {row.ok
                    ? <CheckCircle2 size={13} className="text-success-600 shrink-0 mt-0.5" />
                    : <AlertTriangle size={13} className="text-error-500 shrink-0 mt-0.5" />}
                  <span className="flex-1 min-w-0">
                    <span className="block truncate font-semibold text-slate-700">{row.fileName}</span>
                    <span className="block text-[11px] text-slate-400">
                      {row.ok ? `Filed against ${row.skuCode}` : row.reason}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            {results ? 'Done' : 'Cancel'}
          </Button>
          <Button size="sm" onClick={handleUpload} loading={busy} disabled={files.length === 0}>
            {!busy && <Upload size={14} className="mr-2" />}
            Upload {files.length > 0 ? `${files.length} ` : ''}image{files.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

/* ── The page ─────────────────────────────────────────────────────────────── */

export const ProductDetailsAdmin = () => {
  const navigate = useNavigate();
  const { user } = useUserStore();

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [brand, setBrand] = useState('');
  const [filter, setFilter] = useState('');   // '' | 'true' | 'false'
  const [page, setPage] = useState(1);

  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);

  const [limits, setLimits] = useState(null);
  const [editing, setEditing] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const brands = allowedBrands(user);
  const mayManage = hasPermission(user, PERMISSIONS.MANAGE_INVENTORY_MASTER);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => { setPage(1); }, [debounced, brand, filter]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await productDetailsApi.list({
        search: debounced, brand, page, limit: PAGE_SIZE,
        hasContent: filter === '' ? null : filter === 'true',
      });
      setItems(res.items);
      setPagination(res.pagination);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load the product list.');
    } finally {
      setLoading(false);
    }
  }, [debounced, brand, filter, page]);

  useEffect(() => { load(); }, [load]);

  // The limits are fixed server-side and drive what the editor will even
  // attempt, so they are fetched once rather than per SKU.
  useEffect(() => {
    productDetailsApi.limits().then(setLimits).catch(() => setLimits(null));
  }, []);

  /**
   * Fold a saved detail back into the list without refetching the page.
   *
   * The counts on each row are the only thing that changes, and refetching to
   * learn them would reorder the list under an admin who is working down it.
   */
  const applyToRow = (updated) => {
    setItems((rows) => rows.map((row) => (row.skuCode === updated.skuCode
      ? {
        ...row,
        hasDescription: Boolean(updated.description),
        imageCount: updated.images?.length ?? 0,
        videoCount: updated.videos?.length ?? 0,
        updatedAt: updated.updatedAt ?? new Date().toISOString(),
      }
      : row)));
  };

  if (user && !mayManage) return <Navigate to="/" replace />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Product Details"
        actions={(
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setBulkOpen(true)}>
              <ImagePlus size={15} className="mr-2" />Bulk images
            </Button>
            {/* The spreadsheet side reuses the inventory import wizard rather
                than growing a second one: it already has the preview, the
                row-level errors and the import summary this needs. */}
            <Button size="sm" onClick={() => navigate('/inventory/import?type=product-details')}>
              <Upload size={15} className="mr-2" />Bulk import
            </Button>
          </div>
        )}
      />

      <Card>
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-56">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by SKU or MSIL code…"
              className={`${inputCls} pl-9`}
            />
          </div>

          <select className={`${inputCls} w-auto`} value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value="">All brands</option>
            {brands.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>

          <select className={`${inputCls} w-auto`} value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All products</option>
            <option value="true">With details</option>
            <option value="false">Without details</option>
          </select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/60 text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="text-left px-4 py-2.5 font-bold">SKU</th>
                  <th className="text-left px-4 py-2.5 font-bold">Brand</th>
                  <th className="text-center px-4 py-2.5 font-bold">Description</th>
                  <th className="text-center px-4 py-2.5 font-bold">Images</th>
                  <th className="text-center px-4 py-2.5 font-bold">Videos</th>
                  <th className="text-right px-4 py-2.5 font-bold">Manage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && <TableSkeleton rows={PAGE_SIZE} columns={6} />}

                {!loading && items.map((row) => (
                  <tr key={`${row.brand}-${row.skuCode}`} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-2.5">
                      <span className="font-bold text-slate-900">{row.skuCode}</span>
                      {row.msilCode && (
                        <span className="block text-[11px] text-slate-400">MSIL {row.msilCode}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs font-semibold text-slate-600">{row.brand}</td>
                    <td className="px-4 py-2.5 text-center">
                      {row.hasDescription
                        ? <CheckCircle2 size={15} className="inline text-success-600" />
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-center tabular-nums">
                      <span className={row.imageCount ? 'font-bold text-slate-700' : 'text-slate-300'}>
                        {row.imageCount || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-center tabular-nums">
                      <span className={row.videoCount ? 'font-bold text-slate-700' : 'text-slate-300'}>
                        {row.videoCount || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button size="xs" variant="secondary" onClick={() => setEditing(row.skuCode)}>
                        {row.hasDescription || row.imageCount || row.videoCount ? 'Edit' : 'Add'} details
                      </Button>
                    </td>
                  </tr>
                ))}

                {!loading && items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-sm text-slate-500">
                      No products match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {(pagination?.total ?? 0) > 0 && (
            <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/60 rounded-b-xl">
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                totalItems={pagination.total}
                onPageChange={setPage}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {editing && (
        <DetailEditor
          skuCode={editing}
          limits={limits}
          onSaved={applyToRow}
          onClose={() => setEditing(null)}
        />
      )}

      {bulkOpen && (
        <BulkImageModal
          limits={limits}
          onClose={() => setBulkOpen(false)}
          onDone={load}
        />
      )}
    </div>
  );
};

export default ProductDetailsAdmin;
