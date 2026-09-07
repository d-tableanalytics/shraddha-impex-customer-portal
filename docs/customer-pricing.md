# Customer pricing

What we charge, who may see it, and how it reaches the customer.

## The four price types

Every SKU can carry four rates, in INR per piece. They come from the Ko-ken
pricelist workbook (`docs/Ko-ken Pricelist.xlsx`), one sheet each:

| Type | Key | Sheet | Coverage today |
|---|---|---|---|
| Venus Automation | `venusAutomation` | VENUS AUTOMATION | 7,628 Ko-ken SKUs |
| Trader | `trader` | TRADER | 7,628 |
| End User | `endUser` | END USER | 7,628 |
| MSIL | `msil` | MSIL | 409 |

They live on the product master as `Product.prices.*` — four numbers, no second
collection. `null` means **no rate on file**, which is different from zero and
is printed as a dash rather than a free line.

The MSIL sheet is small on purpose: it is the Maruti contract schedule, and it
covers about 5% of the catalogue. Choosing MSIL on an ordinary booking usually
leaves most lines unrated, which the PO dialog says on the card before the
choice is made.

BIX and IMADA products have no prices — the workbook is the Ko-ken list.

### Reloading the pricelist

```bash
cd backend
npm run pricelist            # DRY RUN — reports coverage and changes, writes nothing
npm run pricelist:apply      # write them

node scripts/import-pricelist.js --file "../docs/Some Other List.xlsx"
node scripts/import-pricelist.js --unmatched unmatched.csv   # rows with no such SKU
```

Dry run is the default because the script rewrites a commercial figure on
thousands of live products. It **never creates a product**: a row whose Item
Code is not in the catalogue is reported and skipped. Load the SKU through the
Inventory Master import first, then re-run this.

The last load matched 98.9% of the Ko-ken catalogue. The rows it could not match
are mostly spreadsheet artefacts (date serials in the code column), not real
SKUs.

## Choosing a rate for a customer

The rate is chosen when the **PO is raised**, in the PO dialog on the sales desk.
The dialog shows all four schedules with what each one totals for that booking,
and how many lines it cannot rate. An MSIL-registered customer has MSIL
suggested, never forced.

The desk sends a price **type**; the server resolves the amount from the product
master. A browser can never post a price.

Once chosen, the rate is **copied onto every row of the order** as `unitPrice`,
with the type beside it. That snapshot is the point: the pricelist is reloaded
whenever the supplier issues a new one, and a raised PO must keep saying what
the customer was actually quoted.

A PO raised before this feature existed carries no pricing. It can be priced
afterwards — or a wrong choice corrected — from the Customer Pricing card on the
booking drawer, which is deliberately not blocked by the PO lock. Every change
is in the audit trail, with the old type and the new one.

## Who sees what

| Reader | Sees |
|---|---|
| `view_pricing` (Admin, Sales, or a role granted it) | All four schedules, and everything on the order |
| The customer, on their own booking, after the PO is raised | The **rate they were given** and the amount — nothing else |
| The customer, before the PO is raised | Nothing |
| Anyone else, including on someone else's booking | Nothing |

The tier NAME is never shown to a customer. Telling them their line is the
"Trader" rate advertises that other tiers exist; what was agreed is a price, so a
price is what the document shows.

This is enforced on the server, not in the UI:

- `Product.prices.*` is `select: false`, so no query carries a rate unless it
  asks for one by name. Aggregations bypass that, so the two pipelines that
  return products `$unset` it explicitly.
- `utils/pricingVisibility.js` strips `priceType`, `pricedAt` and `pricedBy`
  from every non-privileged reader, and strips `unitPrice` too unless the row is
  the reader's own and its PO has been raised.
- `GET /sales/bookings/:orderId/pricing` is the only response in the application
  that carries more than one price for a SKU, and it is behind `view_pricing`.

## The document

The **Picklist / PO Preview** is one component rendering one shape
(`utils/picklistDocument.js`), built by two adapters — one for the sales desk,
one for the customer. Same layout, same columns, same totals; what differs is
what the adapter puts in it. The desk's copy names the price schedule and carries
box numbers, the customer's carries neither.

It is on screen and as a PDF, from the Sales Desk drawer (Picklist) and from the
customer's Booking History drawer (PO Preview, once the PO exists).

**There is no GST column.** The reference invoice this is modelled on has one,
and the portal holds no tax rate for any SKU — `gstCode` on an order is the
customer's GSTIN, an identifier rather than a rate. A tax column computed from a
rate nobody entered would be a number on a commercial document that no data
supports, so the document prices the goods and says the amounts exclude tax.

The company letterhead comes from `frontend/src/constants/company.js`. Its postal
address is **blank** — the portal has never stored one, and it is not worth
guessing on a document customers keep. Fill it in there and it appears on every
preview and PDF at once.

## Checking it

```bash
cd backend
npm run verify:pricing       # 51 checks, read-only against the live database
```

The negative checks are the point: that a rate does not appear where it must
not. It also proves the loaded pricelist against the workbook's own numbers.
