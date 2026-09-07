/**
 * Settings models — SSO providers and third-party integrations.
 *
 * Two collections only. Everything else the reference's Settings page
 * configures already has a home here:
 *
 *   company name, branding, logo   CompanyProfile
 *   roles and permissions          shared/permissions/matrix.js (code, AD-3)
 *   audit trail                    AuditLog
 *   retention                      HrmsConfig (AD-16)
 *
 * AD-1: single tenant, so there is no `organizationId`. The reference keys both
 * of these on `(organizationId, provider|kind)`; here the provider and the kind
 * are the whole key.
 *
 * ---------------------------------------------------------------------------
 * Secrets
 * ---------------------------------------------------------------------------
 * The reference stores `SsoConfig.clientSecret` as a plain column and keeps
 * every integration credential — QuickBooks client secrets, Slack and Teams
 * webhook URLs, biometric communication keys, API keys, auth tokens — inside an
 * unconstrained `config Json` blob. Both are readable by anyone with database
 * access, and its `GET /integrations` hands the whole blob back to the browser.
 *
 * Here every secret is stored as an AD-10 encryption envelope in a `select:
 * false` path, so a secret cannot be projected into a response by accident —
 * only a query that names it explicitly can load it, and nothing but the
 * decrypt path does.
 */

import mongoose from 'mongoose';

import { SSO_PROVIDERS, INTEGRATION_KINDS } from '../../shared/schemas/settings.js';

const { Schema } = mongoose;

/** An AD-10 envelope: `{ v, ct, iv, tag, k }`. Never selected by default. */
const encrypted = {
  type: Schema.Types.Mixed,
  default: null,
  select: false,
};

// ---------------------------------------------------------------------------
// SSO
// ---------------------------------------------------------------------------

const ssoConfigSchema = new Schema(
  {
    provider: {
      type: String,
      enum: SSO_PROVIDERS,
      required: true,
      unique: true,
    },

    clientId: { type: String, required: true, trim: true, maxlength: 500 },

    /** The OAuth client secret, encrypted. */
    clientSecretEnc: encrypted,

    redirectUri: { type: String, required: true, trim: true, maxlength: 2000 },

    active: { type: Boolean, default: true },

    updatedById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'hrms_sso_configs' },
);

/**
 * Presence, never the value.
 *
 * A form that cannot show the secret still has to tell an administrator whether
 * one is stored — otherwise an empty password field is indistinguishable from a
 * provider that was never configured.
 *
 * `clientSecretEnc` is `select: false`, so the CALLER must have selected it for
 * the flag to be meaningful. Every read path here does; a future one that
 * forgets would under-report presence rather than leak a value, which is the
 * right way round for this to fail.
 */
ssoConfigSchema.methods.publicShape = function publicShape() {
  return {
    id: String(this._id),
    provider: this.provider,
    clientId: this.clientId,
    redirectUri: this.redirectUri,
    active: this.active,
    hasClientSecret: Boolean(this.clientSecretEnc),
    updatedAt: this.updatedAt,
  };
};

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

const integrationConfigSchema = new Schema(
  {
    kind: {
      type: String,
      enum: INTEGRATION_KINDS,
      required: true,
      unique: true,
    },

    /**
     * The NON-SECRET fields only — server URLs, company names, device IPs and
     * ports, channel names. Validated against `INTEGRATION_FIELDS` for the kind
     * before it is written, so this is not the open blob the reference keeps.
     */
    config: { type: Schema.Types.Mixed, default: () => ({}) },

    /**
     * The secret fields, each an envelope, keyed by field name.
     *
     * Separate from `config` and `select: false`, so the ordinary read path
     * cannot return them however the serialiser is later edited.
     */
    secretsEnc: encrypted,

    active: { type: Boolean, default: true },

    updatedById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'hrms_integration_configs' },
);

/** Non-secret config plus the NAMES of the secrets held — never their values. */
integrationConfigSchema.methods.publicShape = function publicShape() {
  const secrets = this.secretsEnc ?? {};
  return {
    id: String(this._id),
    kind: this.kind,
    config: this.config ?? {},
    configuredSecrets: Object.keys(secrets),
    active: this.active,
    updatedAt: this.updatedAt,
  };
};

export const SsoConfig =
  mongoose.models.SsoConfig || mongoose.model('SsoConfig', ssoConfigSchema);

export const IntegrationConfig =
  mongoose.models.IntegrationConfig ||
  mongoose.model('IntegrationConfig', integrationConfigSchema);

export default { SsoConfig, IntegrationConfig };
