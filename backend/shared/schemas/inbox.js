/**
 * Inbox wire contracts (AD-6).
 *
 * ---------------------------------------------------------------------------
 * What is deliberately NOT here
 * ---------------------------------------------------------------------------
 * There is no create schema, because there is no create endpoint. Every inbox
 * item is produced by a business event, and the recipient is derived from that
 * event on the server. An endpoint that accepted a recipient would be the
 * impersonation vector the brief names, and the reference — whatever else it
 * gets wrong — has never had one either.
 *
 * The only client inputs are: which page of my own inbox, and which of my own
 * items to mark or archive.
 */

import { z } from 'zod';

import { objectId, paginationQuery } from '../validation/common.js';
import { INBOX_TYPE_LIST, INBOX_CATEGORY_LIST } from '../constants/inbox.js';

/**
 * Reading my inbox.
 *
 * 🔴 The reference's list takes no parameters at all: `findMany({ where: {
 * userId } }), take: 100`. No page, no filter — on a table that stores exactly
 * the two booleans a person wants to filter by, and that nothing ever deletes.
 */
export const listInboxQuery = paginationQuery.extend({
  /** `unread` is the one people actually want. */
  state: z.enum(['all', 'unread', 'read']).default('all'),
  type: z.enum(INBOX_TYPE_LIST).optional(),
  category: z.enum(INBOX_CATEGORY_LIST).optional(),
  /** Archived items are out of the way, not gone. */
  archived: z.enum(['false', 'true']).default('false'),
});

/**
 * Marking several at once.
 *
 * Bounded, and every id is still checked against the caller's own recipient id
 * server-side — a list of ids is not an authorisation.
 */
export const inboxIdsSchema = z.object({
  ids: z.array(objectId).min(1).max(200),
});

export default { listInboxQuery, inboxIdsSchema };
