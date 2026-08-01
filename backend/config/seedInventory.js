import Location from '../models/Location.js';
import InventoryConfig from '../models/InventoryConfig.js';

/**
 * Seeds the inventory master data the IMS cannot run without (Module M1).
 *
 * Both seeds are idempotent and only fire when the collection is empty, so a
 * restart never overwrites a configuration someone has since tuned. Follows the
 * same shape as config/seedRoles.js.
 */

// Seeded to verified Excel parity. The workbook's own legend reads
// "Below 33%" / "33 to 66%" / "66 to 100 %" / "Greater then 100%", and its
// conditional formatting compares stock against Max Level at exactly these
// boundaries.
const DEFAULT_THRESHOLDS = { critical: 33, low: 66, healthy: 100 };

// Free-text reasons cannot be aggregated, and the whole point of capturing a
// reason is to be able to analyse it later. Seeded from the operational
// categories the business already works in.
const DEFAULT_REASON_CODES = [
  { code: 'COUNT_SURPLUS', label: 'Count Surplus', group: 'Count', direction: 'Positive' },
  { code: 'COUNT_SHORTAGE', label: 'Count Shortage', group: 'Count', direction: 'Negative' },
  { code: 'MISCOUNT', label: 'Miscount Correction', group: 'Count', direction: 'Both' },
  { code: 'DAMAGE', label: 'Damage', group: 'Loss', direction: 'Negative' },
  { code: 'THEFT', label: 'Theft', group: 'Loss', direction: 'Negative' },
  { code: 'QUALITY_REJECT', label: 'Quality Rejection', group: 'Loss', direction: 'Negative' },
  { code: 'FOUND', label: 'Found Stock', group: 'Found', direction: 'Positive' },
  { code: 'MISLABELLED', label: 'Mislabelled', group: 'Found', direction: 'Both' },
  { code: 'WRONG_BIN', label: 'Wrong Bin', group: 'Found', direction: 'Both' },
  { code: 'DATA_ENTRY', label: 'Data Entry Error', group: 'Correction', direction: 'Both' },
  { code: 'SYSTEM_MIGRATION', label: 'System Migration', group: 'Correction', direction: 'Both' },
  { code: 'REVERSAL', label: 'Reversal', group: 'Correction', direction: 'Both' },
  { code: 'SAMPLE', label: 'Sample', group: 'Non-Sale Issue', direction: 'Negative' },
  { code: 'WARRANTY', label: 'Warranty Replacement', group: 'Non-Sale Issue', direction: 'Negative' },
  { code: 'INTERNAL_USE', label: 'Internal Use', group: 'Non-Sale Issue', direction: 'Negative' },
];

export const seedInventoryDefaults = async () => {
  try {
    // ── Default location ─────────────────────────────────────────────────
    // Whether the business runs one stock site or four is still an open
    // question. Seeding a single DEFAULT keeps every movement addressable from
    // day one, so switching multi-site on later is data rather than a schema
    // change.
    if ((await Location.countDocuments()) === 0) {
      await Location.create({
        code: 'DEFAULT',
        name: 'Main Warehouse',
        type: 'Warehouse',
        isDefault: true,
        active: true,
      });
      console.log('[Seed] Default stock location created.');
    }

    // ── Global inventory configuration ───────────────────────────────────
    if ((await InventoryConfig.countDocuments({ scope: 'global' })) === 0) {
      await InventoryConfig.create({
        scope: 'global',
        scopeValue: null,
        thresholds: DEFAULT_THRESHOLDS,
        // v1 is the formula the workbooks demonstrably use. v2 (additive safety
        // factor) is available as a config switch pending the business decision.
        formulaVersion: 'v1',
        reasonCodes: DEFAULT_REASON_CODES,
        effectiveFrom: new Date(),
        changeNote: 'Seeded defaults — Excel parity thresholds and formula v1.',
      });
      console.log('[Seed] Global inventory configuration created.');
    }
  } catch (error) {
    console.error(`[Seed Error] Failed to seed inventory defaults: ${error.message}`);
  }
};

export default seedInventoryDefaults;
