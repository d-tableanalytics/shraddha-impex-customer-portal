/**
 * Versioned statutory configuration (AD-12).
 *
 * Ported from the reference's `statutory-config.service.ts`. Each row carries
 * an effective date range; the payroll engine resolves the row live on the
 * run's month and computes against it.
 *
 * ---------------------------------------------------------------------------
 * 🔴 THE POINT OF THIS MODULE
 * ---------------------------------------------------------------------------
 * AD-12 and the brief both say it: no Indian state's statutory rules may be
 * hardcoded. Every rate, ceiling, PT slab and LWF rule is a value in the
 * `config` payload of a row in this collection, keyed by state where the rule
 * is state-specific.
 *
 * Two consequences worth being explicit about:
 *
 *   - THERE IS NO SEED. The reference defaults its Zod schema to one year's
 *     Indian figures, so an organisation that never configures anything still
 *     computes PF at 12% on a ₹15,000 ceiling. That looks convenient and is a
 *     compliance trap: nobody chose those numbers, and nobody knows when they
 *     stopped being right. Here a payroll run with no effective config REFUSES,
 *     which is the same direction AD-12 takes for an unconfigured state and
 *     AD-16 takes for an unconfigured retention window.
 *
 *   - A STATE ABSENT FROM `pt` OR `lwf` HAS NONE. That is a real answer, not a
 *     gap — several states levy no professional tax at all.
 *
 * ---------------------------------------------------------------------------
 * History is immutable once it is in force
 * ---------------------------------------------------------------------------
 * A config that has already been used to pay someone is never edited: a
 * regenerated payslip must reproduce the one the employee received. Changing
 * the rules means adding a row with a later `effectiveFrom`, which closes the
 * previous one automatically.
 */

import mongoose from 'mongoose';

import { StatutoryConfig, PayrollRun } from '../../../models/hrms/PayrollModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsValidationError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));

const toDto = (row) => ({
  id: idStr(row._id),
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo ?? null,
  config: row.config,
  note: row.note ?? null,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

/** Today, as `YYYY-MM-DD`, in UTC. */
const todayIso = () => new Date().toISOString().slice(0, 10);

export async function listConfigs() {
  const rows = await StatutoryConfig.find({}).sort({ effectiveFrom: -1 }).lean();
  return rows.map(toDto);
}

export async function getConfig(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Statutory configuration');
  const row = await StatutoryConfig.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('Statutory configuration');
  return toDto(row);
}

/**
 * The configuration in force on a given day.
 *
 * Returns null rather than throwing: the caller decides what an absent config
 * means. For a payroll run it is a refusal; for the structure preview it is a
 * message explaining that statutory lines cannot be shown yet.
 *
 * @param {string} on `YYYY-MM-DD`
 */
export async function resolveEffectiveConfig(on = todayIso()) {
  const row = await StatutoryConfig.findOne({
    effectiveFrom: { $lte: on },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: on } }],
  })
    .sort({ effectiveFrom: -1 })
    .lean();
  return row ? toDto(row) : null;
}

/**
 * Add a version.
 *
 * The previously-open row is closed the day before this one opens, so the
 * timeline has no gap and no overlap — which is what makes
 * `resolveEffectiveConfig` a single unambiguous lookup rather than a choice
 * between two candidates.
 */
export async function createConfig(input, context = {}) {
  const previous = await StatutoryConfig.findOne({
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: input.effectiveFrom } }],
  })
    .sort({ effectiveFrom: -1 })
    .lean();

  if (previous && previous.effectiveFrom >= input.effectiveFrom) {
    throw new HrmsConflictError(
      `A configuration already starts on ${previous.effectiveFrom}. A new version must start after it.`,
      { code: 'STATUTORY_CONFIG_OVERLAP' },
    );
  }

  const row = await StatutoryConfig.create({
    ...input,
    createdByUserId: context.user?._id ?? null,
  });

  if (previous) {
    const dayBefore = new Date(`${input.effectiveFrom}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    await StatutoryConfig.updateOne(
      { _id: previous._id },
      { $set: { effectiveTo: dayBefore.toISOString().slice(0, 10) } },
    );
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.STATUTORY_CONFIG_CREATED,
    `Statutory configuration effective from ${input.effectiveFrom}`,
    context.req,
    {
      meta: {
        configId: idStr(row._id),
        effectiveFrom: input.effectiveFrom,
        closedPrevious: previous ? idStr(previous._id) : null,
        // The full payload is recorded: this is the compliance trail for what
        // rules were in force when, and a summary would not answer that.
        config: input.config,
      },
    },
  );

  return toDto(row.toObject());
}

/**
 * Edit a version that has not taken effect yet.
 *
 * A config whose `effectiveFrom` has arrived is locked, and one that a payroll
 * run has actually consumed is doubly so — the run stamps `statutoryConfigId`,
 * so that link is checked rather than inferred from dates alone.
 */
export async function updateConfig(id, input, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Statutory configuration');

  const existing = await StatutoryConfig.findById(id).lean();
  if (!existing) throw new HrmsNotFoundError('Statutory configuration');

  await assertNotInForce(existing, 'changed');

  const row = await StatutoryConfig.findByIdAndUpdate(id, { $set: input }, { new: true });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.STATUTORY_CONFIG_UPDATED,
    `Updated the statutory configuration effective from ${row.effectiveFrom}`,
    context.req,
    { meta: { configId: idStr(row._id), changed: Object.keys(input), config: row.config } },
  );

  return toDto(row.toObject());
}

export async function deleteConfig(id, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Statutory configuration');

  const existing = await StatutoryConfig.findById(id).lean();
  if (!existing) throw new HrmsNotFoundError('Statutory configuration');

  await assertNotInForce(existing, 'deleted');

  await StatutoryConfig.deleteOne({ _id: id });

  // Reopen the row this one had closed, so deleting a future version does not
  // leave a hole in the timeline that `resolveEffectiveConfig` would fall into.
  const dayBefore = new Date(`${existing.effectiveFrom}T00:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  await StatutoryConfig.updateOne(
    { effectiveTo: dayBefore.toISOString().slice(0, 10) },
    { $set: { effectiveTo: existing.effectiveTo ?? null } },
  );

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.STATUTORY_CONFIG_DELETED,
    `Deleted the statutory configuration effective from ${existing.effectiveFrom}`,
    context.req,
    { meta: { configId: idStr(existing._id) } },
  );

  return { id: idStr(existing._id), deleted: true };
}

/** Refuse a write to a config that is, or has been, in force. */
async function assertNotInForce(existing, verb) {
  if (existing.effectiveFrom <= todayIso()) {
    throw new HrmsConflictError(
      `This configuration took effect on ${existing.effectiveFrom} and cannot be ${verb}. ` +
        'Add a new version with a later start date instead.',
      { code: 'STATUTORY_CONFIG_IN_FORCE' },
    );
  }

  const usedBy = await PayrollRun.countDocuments({ statutoryConfigId: existing._id });
  if (usedBy > 0) {
    throw new HrmsConflictError(
      `${usedBy} payroll run(s) were computed against this configuration and it cannot be ${verb}.`,
      { code: 'STATUTORY_CONFIG_USED' },
    );
  }
}

/**
 * The states this configuration actually covers.
 *
 * Surfaced so the compensation form can warn when an employee's state has no
 * PT or LWF entry — which is legitimate for some states and a configuration
 * oversight for others, and only a human can tell which.
 */
export function coveredStates(config) {
  if (!config?.config) return { pt: [], lwf: [] };
  return {
    pt: Object.keys(config.config.pt ?? {}),
    lwf: Object.keys(config.config.lwf ?? {}),
  };
}

export default {
  listConfigs,
  getConfig,
  resolveEffectiveConfig,
  createConfig,
  updateConfig,
  deleteConfig,
  coveredStates,
};
