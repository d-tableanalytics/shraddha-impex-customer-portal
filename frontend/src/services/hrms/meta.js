import { hrmsClient } from "./client";

/** The signed-in user's HRMS actor: role keys, resolved permissions, modules. */
export const hrmsMeApi = {
  get: () => hrmsClient.get("/me"),
};

/**
 * What the HRMS foundation currently has wired up.
 *
 * The permission matrix declares 31 modules; far fewer are built. This
 * separates "you may not" from "not built yet", which is what lets the shell
 * show an honest empty state rather than an invented number or a misleading
 * permission error.
 */
export const hrmsStatusApi = {
  get: () => hrmsClient.get("/status"),
};
