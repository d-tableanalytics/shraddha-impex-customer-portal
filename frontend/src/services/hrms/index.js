/**
 * HRMS API services.
 *
 * One module per domain, each a thin wrapper over `hrmsClient`. Screens call
 * these, never axios directly, so an endpoint change lands in one place.
 *
 * Phase 1 covers only what the foundation itself needs. A service is added in
 * the same commit as the module it serves - not in advance.
 */

export { hrmsClient, HrmsApiError } from "./client";
export { hrmsMeApi, hrmsStatusApi } from "./meta";
export { companyApi } from "./company";
export { retentionApi } from "./retention";
export { employeesApi, employeeCustomFieldsApi } from "./employees";
