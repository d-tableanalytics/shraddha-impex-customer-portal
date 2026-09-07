/**
 * HRMS startup wiring.
 *
 * Registers the handlers, access rules and providers that the generic
 * machinery looks up at runtime. Called once from server.js, alongside the
 * portal's own seeders.
 *
 * Registration is explicit and central rather than a side effect of importing a
 * module, so what is active in a running system is answerable by reading one
 * file - and so importing a service from a script does not silently arm a
 * background behaviour. The portal made the same choice for its alert
 * subscriber, for the same reason.
 */

import { registerRetentionHandler } from './retention/retention.registry.js';
import { auditRetentionHandler } from './retention/auditRetention.handler.js';
import { inboxRetentionHandler } from './inbox/inbox.service.js';
import { setEmployeeResolver } from '../../middlewares/hrmsAuth.js';
import {
  resolveEmployeeByUser,
  describe as describeReferences,
  registerReferenceProvider,
} from './references/reference.service.js';
import {
  employeeReferenceProvider,
  employeePersistencePort,
} from './employees/employee.provider.js';
import {
  departmentReferenceProvider,
  locationReferenceProvider,
} from './org/org.provider.js';
import { registerEmployeePersistence } from './import/adapter.js';
import { attendanceSelfieRetentionHandler } from './attendance/selfieRetention.handler.js';
import { registerSelfieAccessRule } from './attendance/selfie.service.js';
import { registerFileAccessRule } from './storage/storage.service.js';
import { resolveReceiptAccess } from './expenses/claim.service.js';
import { resolveLetterAccess } from './exits/exit.service.js';
import { resolveResumeAccess } from './hiring/candidate.service.js';
import {
  resolveEmployeeDocumentAccess,
  resolveCompanyDocumentAccess,
} from './documents/document.service.js';
import { documentRetentionHandler } from './documents/documentRetention.handler.js';
import { resolveOfferLetterAccess } from './onboarding/offerLetter.service.js';
import { RETENTION_CATEGORIES, STORAGE_CATEGORIES, AUDIT_ACTIONS } from '../../shared/constants/hrms.js';

/**
 * Wire up the HRMS foundation.
 *
 * Phase 1 registers what Phase 1 owns. Later phases add their own:
 *   attendance  -> the selfie retention handler + its file access rule
 *   payroll     -> payslip and bank-file access rules
 */
export function bootstrapHrms() {
  registerRetentionHandler(RETENTION_CATEGORIES.AUDIT_LOG, auditRetentionHandler);

  /**
   * Attendance fills the two hooks Phase 0 named in this file's own comment.
   *
   * The retention handler is what makes the 90-day selfie policy real: without
   * it the sweep REPORTS the category as unimplemented and deletes nothing, so
   * the configured window would look enforced while photographs accumulated
   * indefinitely.
   *
   * The access rule is what makes selfies readable AT ALL. The storage service
   * fails closed for an unregistered category, so until this runs every request
   * for a selfie is refused - which is the correct default, and the reason
   * registering it here is a deliberate act rather than an import side effect.
   */
  registerRetentionHandler(
    RETENTION_CATEGORIES.ATTENDANCE_SELFIES,
    attendanceSelfieRetentionHandler,
  );
  registerSelfieAccessRule();

  // Employee Master fills the two registries Phase 0 left empty on purpose.
  // Until this ran, every employee lookup rejected with 503 and the import
  // pipeline refused to commit - which was the correct behaviour while the
  // collection did not exist.
  registerReferenceProvider('employee', employeeReferenceProvider);
  registerEmployeePersistence(employeePersistencePort);

  // Org Structure fills the last two registries. With these registered,
  // `assertReferencesResolve` stops answering 503 for a departmentId or
  // locationId and starts doing what it was written to do - checking that the
  // id actually resolves, and refusing it when it does not.
  registerReferenceProvider('department', departmentReferenceProvider);
  registerReferenceProvider('location', locationReferenceProvider);

  /**
   * Bridge the actor's employee lookup onto the reference service.
   *
   * Phase 0 left `setEmployeeResolver` as a hook; this connects it to the one
   * abstraction that resolves employees, so there is a single implementation
   * rather than the guard growing its own.
   *
   * Until the Employee Master registers a provider, `resolveEmployeeByUser`
   * throws HrmsNotImplementedError. Returning null instead would be wrong in a
   * way that is hard to see: the actor would silently carry no departmentId and
   * an empty managerChain, and every `team` and `department` scope check would
   * quietly evaluate against nothing. Failing is the safe direction.
   *
   * The one case that must NOT fail is an actor with no employee record at all
   * - an HR admin who is not themselves an employee is legitimate - so a
   * genuine null from a registered provider passes through untouched.
   */
  setEmployeeResolver(async (userId) => {
    if (!describeReferences().employee) {
      // No provider yet. The guard treats this as "no employee context", which
      // is correct for Phase 1: no module needs team scope until one exists.
      return null;
    }
    return resolveEmployeeByUser(userId);
  });

  /**
   * Expense receipts.
   *
   * Registering the rule is what makes a receipt readable at all: the storage
   * layer fails closed for a category nobody has declared rules for. The rule
   * resolves the object key back to the claim's owner, so the same scope that
   * governs seeing a claim governs seeing its receipt — and the read is audited
   * as a RECEIPT view rather than as an ordinary document one.
   */
  registerFileAccessRule(STORAGE_CATEGORIES.EXPENSE_RECEIPT, {
    resolve: resolveReceiptAccess,
    auditAction: AUDIT_ACTIONS.EXPENSE_RECEIPT_VIEWED,
  });

  /**
   * A relieving letter belongs to the person who left, and to HR. A manager who
   * could see the exit request while it was open has no claim on the letter.
   */
  registerFileAccessRule(STORAGE_CATEGORIES.LETTER, {
    resolve: resolveLetterAccess,
    auditAction: AUDIT_ACTIONS.EXIT_LETTER_VIEWED,
  });

  /**
   * Candidate résumés.
   *
   * Registering the rule is what makes a CV readable at all — the storage layer
   * fails closed for a category nobody has declared rules for. A candidate is
   * not an employee, so there is no owner context to evaluate a self or team
   * scope against: the rule returns an absolute `hiring:view:org` requirement,
   * which is the line the reference draws too. The read is audited as a RÉSUMÉ
   * view rather than as an ordinary document one.
   */
  registerFileAccessRule(STORAGE_CATEGORIES.CANDIDATE_RESUME, {
    resolve: resolveResumeAccess,
    auditAction: AUDIT_ACTIONS.RESUME_VIEWED,
  });

  /**
   * Onboarding offer letters.
   *
   * A SEPARATE category from `letter`, which Exits owns for relieving letters.
   * `registerFileAccessRule` is a Map.set — registering `letter` twice would
   * silently replace the relieving-letter rule with this one and hand every
   * exit document the wrong owner. The subject reads their own; org scope reads
   * anybody's.
   */
  registerFileAccessRule(STORAGE_CATEGORIES.OFFER_LETTER, {
    resolve: resolveOfferLetterAccess,
    auditAction: AUDIT_ACTIONS.OFFER_LETTER_VIEWED,
  });

  /**
   * Employee documents, and the signature images attached to acknowledgments.
   *
   * Neither `EMPLOYEE_DOCUMENT` nor `COMPANY_ASSET` had a rule before this
   * module, so these are additions rather than replacements - the storage layer
   * fails closed for an unregistered category, which is why a document was
   * unreadable until now.
   *
   * Self or org only: a personal document is a contract or an ID proof, and a
   * reporting manager has no claim on one.
   */
  registerFileAccessRule(STORAGE_CATEGORIES.EMPLOYEE_DOCUMENT, {
    resolve: resolveEmployeeDocumentAccess,
    auditAction: AUDIT_ACTIONS.DOCUMENT_VIEWED,
  });
  /** The company library and published policies. */
  registerFileAccessRule(STORAGE_CATEGORIES.COMPANY_ASSET, {
    resolve: resolveCompanyDocumentAccess,
    auditAction: AUDIT_ACTIONS.DOCUMENT_VIEWED,
  });

  /**
   * Employee documents keep the retention policy they already had - `retain`,
   * forever. Registering a handler is what stops the sweep reporting the
   * category as unimplemented, so a window an administrator later configures is
   * actually applied rather than merely displayed.
   */
  registerRetentionHandler(
    RETENTION_CATEGORIES.EMPLOYEE_DOCUMENTS,
    documentRetentionHandler,
  );

  /**
   * Inbox notifications. Phase 0 declared this category with `days: null` -
   * retain - and that default stands; what was missing was a handler, so the
   * sweep reported the category as unimplemented and a window an administrator
   * configured would have been displayed but never applied.
   *
   * The reference has no retention for inbox rows in any form, which is why its
   * table grows without bound behind a hardcoded hundred-row read ceiling.
   */
  registerRetentionHandler(RETENTION_CATEGORIES.INBOX_ITEMS, inboxRetentionHandler);

  return {
    retentionHandlers: [
      RETENTION_CATEGORIES.AUDIT_LOG,
      RETENTION_CATEGORIES.ATTENDANCE_SELFIES,
      RETENTION_CATEGORIES.EMPLOYEE_DOCUMENTS,
      RETENTION_CATEGORIES.INBOX_ITEMS,
    ],
    references: describeReferences(),
  };
}

export default bootstrapHrms;
