/**
 * Delegation API service.
 *
 * Communicates with `/api/v1/delegation` to manage tasks delegated by the active user.
 * Follows the portal pattern using the shared axios instance with token refresh.
 */

import { api } from './api';

const PREFIX = '/delegation';

async function get(path = '', params) {
  const res = await api.get(`${PREFIX}${path}`, { params });
  return res.data?.data;
}

async function post(path = '', data) {
  const res = await api.post(`${PREFIX}${path}`, data);
  return res.data?.data;
}

/**
 * The WHOLE response body, not just its `data`.
 *
 * The bulk endpoints answer `{ success, message, modifiedCount, skipped }` with
 * nothing under `data`, because how many rows moved is not a row. `post` above
 * would unwrap that to `undefined` and the screen would be left reporting the
 * size of the selection instead of what actually happened — which matters here,
 * since these endpoints deliberately skip tasks mirrored from an O2D stage.
 */
async function postEnvelope(path = '', data) {
  const res = await api.post(`${PREFIX}${path}`, data);
  return res.data;
}

async function put(path = '', data) {
  const res = await api.put(`${PREFIX}${path}`, data);
  return res.data?.data;
}

async function patch(path = '', data) {
  const res = await api.patch(`${PREFIX}${path}`, data);
  return res.data?.data;
}

async function del(path = '', params) {
  const res = await api.delete(`${PREFIX}${path}`, { params });
  return res.data?.data;
}

export const delegationService = {
  // Read
  getDelegations:        (params) => get('', params),
  getDeletedDelegations: (params) => get('/deleted', params),
  getDelegationById:     (id)     => get(`/${id}`),
  getCategories:         ()       => get('/meta/categories'),
  getUsers:              ()       => get('/meta/users'),

  // Task CRUD
  createDelegation:      (data)     => post('', data),
  updateDelegation:      (id, data) => put(`/${id}`, data),
  deleteDelegation:      (id)       => del(`/${id}`),
  restoreDelegation:     (id)       => patch(`/${id}/restore`),

  // Bulk Operations
  bulkUpdateStatus:      (ids, status) => postEnvelope('/bulk-status', { ids, status }),
  bulkDelete:            (ids)         => postEnvelope('/bulk-delete', { ids }),

  // Lifecycle actions
  verifyAndComplete: (id, data) => post(`/${id}/verify`, data),

  // Subtasks
  addSubtask:        (id, data) => post(`/${id}/subtasks`, data),
  toggleSubtask:     (id, subtaskId, completed) =>
    patch(`/${id}/subtasks/${subtaskId}/toggle`, { completed }),

  // Remarks / Audit trail
  addRemark:         (id, data) => post(`/${id}/remarks`, data),

  // Modals & Schedule
  reviseDueDate:     (id, data) => post(`/${id}/revise-date`, data),
  addReminder:       (id, data) => post(`/${id}/reminders`, data),
  addFollowUp:       (id, data) => post(`/${id}/follow-ups`, data),
};

export default delegationService;
