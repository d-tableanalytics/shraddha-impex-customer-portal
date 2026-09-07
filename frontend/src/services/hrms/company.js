import { hrmsClient } from "./client";

/**
 * Company profile (AD-1: single tenant).
 *
 * This is what replaces DTA's per-tenant Organization. There is exactly one.
 */
export const companyApi = {
  get: () => hrmsClient.get("/company"),
  update: (updates) => hrmsClient.put("/company", updates),
};
