# Roles & Permissions in the Customer Portal

`/admin/permissions`: what each role may do in the Customer Portal, per module,
screen and action (View / Create / Edit / Delete / Approve).

## One roles collection, two editors

Both portals read and write the same `roles` collection, and a role carries both
portals' cells. Sales, for example, holds `sales.bookings` here and `o2d.orders`
in the Employee Portal. Each portal's screen shows only its own modules.

The save endpoints used to **replace** a role's stored grants with whatever was
sent. That was safe only while one screen, the Employee Portal's, sent every
stored cell back. This portal does not rely on the client for it. Every save
made here goes through `backend/utils/portalGrants.js`:

- cells for sub-modules this portal serves come from the request;
- every other cell (FMS, Work Queue, HRMS) is kept exactly as stored, whatever
  the request says;
- the same applies to the legacy flat `permissions` list and to per-account
  **Extra Access** (`PUT /users/:id/access`).

So this screen can neither remove nor add an Employee Portal grant. Nothing in
the Employee Portal, and none of the shared-contract files, changed.

## Who can use it

Super Admin and Admin. `manage_roles` and its per-action keys belong to
`administration.roles`, which the shared registry tags as the Employee
Portal's, so this portal's domain fence removes them from every other role.
Letting another role in means retagging that sub-module in
`config/moduleRegistry.js`. That is a shared-contract change and must be made
in both repositories.

## Cells that save differently

Some cells compile to more than their label says, because a ticked cell grants
**all** of its keys:

| Cell | Would grant | Here |
|---|---|---|
| Customer Management: View / Create / Edit | `manage_customer_users` **and** `manage_users` (full user administration, Admins included) | **Narrowed**: saved as the flat key `manage_customer_users` only. The three boxes move together. |
| New Booking / Bulk Upload: View | `create_order` **and** `view_all_bookings` (every customer's bookings) | **Derived**: follows Create, cannot be changed here. |
| Admin Panel: View | `manage_users` **and** `manage_roles` | **Derived**: follows Internal User Management → View. |

The server sends these rules as `rules` on `GET /roles/registry`, and the
screen draws from them (`frontend/src/utils/roleMatrix.js`). The real fix is to
narrow those cells in `config/moduleRegistry.js`, which is shared-contract code.

## Enforcement

- **Routes:** every screen is guarded by its own View cell
  (`components/layout/ModuleRoute.jsx`), the same test the server's menu uses.
  Refusal is a panel, not a redirect.
- **User administration:** creating or editing an account checks
  `administration.customers.<action>` for a Customer account and
  `administration.users.<action>` for staff. It used to check the screen's view
  key for everything. Suspending counts as an edit: it is reversible, and Sales
  suspends customers.
- **Booking drawer:** status, PO and resend controls follow `manage_orders`,
  the key their routes check, instead of the role name.
- **Role cache:** reloaded every minute (`ROLE_CACHE_REFRESH_MS`), so changes
  made from the Employee Portal or by `npm run roles:baseline:apply` apply here
  without a restart.

## Known limits (need registry changes)

These cells share one key, so the matrix cannot separate them:

- Create and Edit on Inventory Master, Adjustments, Counts and Customer
  Management.
- Delete and Approve on Booking History.
- The eight Inventory View cells, which are all `view_inventory`.

Ticking one of these ticks the others in effect.

## Tests

```bash
cd backend  && node --test --experimental-test-module-mocks tests/roles-customer-portal.test.js
cd frontend && npx vitest run src/pages/Admin/Settings/rolesPermissions.test.jsx
```
