import { hrmsClient } from "./client";

/** Retention policy (AD-16). Configurable data, never constants in code. */
export const retentionApi = {
  get: () => hrmsClient.get("/config/retention"),
  history: () => hrmsClient.get("/config/retention/history"),
  update: (payload) => hrmsClient.put("/config/retention", payload),
  /** Defaults to a dry run server-side; pass { dryRun: false } to perform it. */
  sweep: (payload = {}) => hrmsClient.post("/config/retention/sweep", payload),
};
