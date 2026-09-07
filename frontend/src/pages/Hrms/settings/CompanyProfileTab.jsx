import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Upload } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { ErrorState } from "../../../components/hrms/ErrorState";
import { settingsApi, BRAND_TOKEN_LABELS } from "../../../services/hrms/settings";

/**
 * Company Profile.
 *
 * The reference's tab — Identity, Logo, Branding — over the company profile
 * this codebase already has. There is no second document and no second
 * endpoint: this reads and writes the same record `/hrms/company` serves, and
 * deliberately edits a narrower slice of it than the company module does.
 *
 * The reference's fourth card is a red **Danger Zone** whose button wipes every
 * employee, payroll run and leave balance and reseeds a demo tenant. It is not
 * reproduced, and the reason is stated in the analysis rather than left as a
 * silent omission.
 */

const LOGO_MAX_BYTES = 512 * 1024;

export function CompanyProfileTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({ legalName: "", displayName: "", brand: {} });
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await settingsApi.company();
      setData(next);
      setForm({
        legalName: next.legalName ?? "",
        displayName: next.displayName ?? "",
        brand: { ...next.brand },
      });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (event) => {
    event.preventDefault();
    if (!form.legalName.trim() || !form.displayName.trim()) {
      toast.error("A company name is required.");
      return;
    }
    setSaving(true);
    try {
      const next = await settingsApi.updateCompany({
        legalName: form.legalName.trim(),
        displayName: form.displayName.trim(),
        brand: form.brand,
      });
      setData(next);
      toast.success("Company profile updated.");
    } catch (err) {
      toast.error(err?.message ?? "Those settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const onPickLogo = async (event) => {
    const file = event.target.files?.[0];
    // Reset immediately so re-picking the same file still fires a change.
    event.target.value = "";
    if (!file) return;

    // Checked here for a fast, clear message; the server checks the size, the
    // declared type AND the PNG magic bytes, because none of this is trusted.
    if (file.type !== "image/png") {
      toast.error("The logo must be a PNG file.");
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      toast.error("The logo must be under 512 KB.");
      return;
    }

    setUploading(true);
    try {
      setData(await settingsApi.uploadLogo(file));
      toast.success("Logo updated.");
    } catch (err) {
      toast.error(err?.response?.data?.message ?? err?.message ?? "That logo could not be uploaded.");
    } finally {
      setUploading(false);
    }
  };

  if (error) {
    return (
      <ErrorState
        title="Company settings could not be loaded"
        description={error.message}
        onRetry={load}
      />
    );
  }

  if (loading) {
    return <div data-testid="company-skeleton" className="h-64 animate-pulse rounded-lg bg-slate-100" />;
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ---- Identity ---- */}
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-900">Identity</h3>

          <div className="space-y-3">
            <div>
              <label htmlFor="legal-name" className="mb-1 block text-sm font-medium text-slate-700">
                Legal name
              </label>
              <Input
                id="legal-name"
                value={form.legalName}
                onChange={(e) => setForm((c) => ({ ...c, legalName: e.target.value }))}
                maxLength={200}
              />
              <p className="mt-1 text-xs text-slate-500">
                As it appears on payslips and statutory filings.
              </p>
            </div>

            <div>
              <label htmlFor="display-name" className="mb-1 block text-sm font-medium text-slate-700">
                Display name
              </label>
              <Input
                id="display-name"
                value={form.displayName}
                onChange={(e) => setForm((c) => ({ ...c, displayName: e.target.value }))}
                maxLength={200}
              />
              <p className="mt-1 text-xs text-slate-500">Shown in the sidebar and page headers.</p>
            </div>
          </div>
        </section>

        {/* ---- Logo ---- */}
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-1 text-sm font-semibold text-slate-900">Company logo</h3>
          <p className="mb-3 text-xs text-slate-500">
            Shown in the sidebar and embedded on payslip PDFs. PNG, under 512 KB.
          </p>

          <div className="flex items-center gap-4">
            <div className="flex min-h-[80px] flex-1 items-center justify-center rounded-lg border border-slate-200 bg-white p-3">
              {data?.logoUrl ? (
                <img
                  src={data.logoUrl}
                  alt="Current company logo"
                  className="max-h-14 max-w-full object-contain"
                />
              ) : (
                <span className="text-xs text-slate-400">No logo uploaded</span>
              )}
            </div>

            <div>
              <label htmlFor="logo-file" className="sr-only">
                Choose a logo
              </label>
              <input
                id="logo-file"
                ref={fileRef}
                type="file"
                accept="image/png"
                className="sr-only"
                onChange={onPickLogo}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="mr-1 h-4 w-4" aria-hidden="true" />
                {uploading ? "Uploading…" : "Change"}
              </Button>
            </div>
          </div>
        </section>
      </div>

      {/* ---- Branding ---- */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Branding</h3>
        <p className="mb-3 text-xs text-slate-500">
          Four tokens, and only these four — the server refuses anything else.
        </p>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Object.entries(BRAND_TOKEN_LABELS).map(([token, label]) => (
            <div key={token}>
              <label
                htmlFor={`brand-${token}`}
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                {label}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id={`brand-${token}`}
                  type="color"
                  value={form.brand[token] ?? "#000000"}
                  onChange={(e) =>
                    setForm((c) => ({ ...c, brand: { ...c.brand, [token]: e.target.value } }))
                  }
                  className="h-9 w-10 cursor-pointer rounded border border-slate-300"
                />
                <span className="font-mono text-xs uppercase text-slate-500">
                  {form.brand[token] ?? "—"}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="flex justify-end">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

export default CompanyProfileTab;
