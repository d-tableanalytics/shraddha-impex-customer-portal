/**
 * Company profile (AD-1: single tenant).
 */

import CompanyProfile from '../../../models/hrms/CompanyProfile.js';
import { getReadUrl } from '../../../utils/hrms/storage/index.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { STORAGE_CATEGORIES, INDIAN_STATE_CODES } from '../../../shared/constants/hrms.js';
import { z } from '../../../shared/validation/common.js';

export const updateCompanyProfileSchema = z
  .object({
    legalName: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(200),
    registeredAddress: z.string().trim().max(1000).nullable(),
    city: z.string().trim().max(120).nullable(),
    // Explicitly nullable: clearing it is meaningful, and null BLOCKS payroll
    // rather than falling back to a state (AD-12).
    defaultStateCode: z.enum(INDIAN_STATE_CODES).nullable(),
    statutory: z
      .object({
        pan: z.string().trim().max(20).nullable(),
        tan: z.string().trim().max(20).nullable(),
        gstin: z.string().trim().max(20).nullable(),
        pfEstablishmentCode: z.string().trim().max(40).nullable(),
        esiEstablishmentCode: z.string().trim().max(40).nullable(),
      })
      .partial(),
    weekendDays: z.array(z.number().int().min(0).max(6)).max(7),
    financialYearStartMonth: z.number().int().min(1).max(12),
    brand: z.record(z.string(), z.unknown()),
  })
  .partial();

const serialise = async (profile) => {
  const readiness = profile.statutoryReadiness();
  return {
    legalName: profile.legalName,
    displayName: profile.displayName,
    logoKey: profile.logoKey,
    // A presigned URL rather than a path: the object is private and served
    // straight from S3 (AD-7).
    logoUrl: profile.logoKey
      ? await getReadUrl(profile.logoKey, { category: STORAGE_CATEGORIES.COMPANY_ASSET })
      : null,
    registeredAddress: profile.registeredAddress,
    city: profile.city,
    defaultStateCode: profile.defaultStateCode,
    statutory: profile.statutory,
    weekendDays: profile.weekendDays,
    financialYearStartMonth: profile.financialYearStartMonth,
    brand: profile.brand,
    // Surfaced so the UI can say what payroll is still missing, instead of a
    // run failing later with no explanation (AD-12).
    statutoryReadiness: readiness,
    updatedAt: profile.updatedAt,
  };
};

/** GET /api/v1/hrms/company */
export const getCompanyProfile = async (req, res, next) => {
  try {
    const profile = await CompanyProfile.load();
    res.status(200).json({ success: true, data: await serialise(profile) });
  } catch (error) {
    next(error);
  }
};

/** PUT /api/v1/hrms/company */
export const updateCompanyProfile = async (req, res, next) => {
  try {
    const profile = await CompanyProfile.load();
    const updates = req.body;

    const before = {
      defaultStateCode: profile.defaultStateCode,
      legalName: profile.legalName,
    };

    for (const [key, value] of Object.entries(updates)) {
      if (key === 'statutory') {
        profile.statutory = { ...profile.statutory?.toObject?.() ?? profile.statutory, ...value };
      } else {
        profile[key] = value;
      }
    }

    await profile.save();

    await recordAudit(
      req.user,
      'hrms.company.updated',
      `Company profile updated: ${Object.keys(updates).join(', ')}`,
      req,
      { meta: { fields: Object.keys(updates), before } },
    );

    res.status(200).json({ success: true, data: await serialise(profile) });
  } catch (error) {
    next(error);
  }
};

export default { getCompanyProfile, updateCompanyProfile, updateCompanyProfileSchema };
