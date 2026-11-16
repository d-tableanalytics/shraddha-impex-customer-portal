import { useState, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { useSearchParams } from "react-router-dom";
import { useCartStore } from "../../store/cartStore";
import { BookingReviewModal } from "../../components/booking/BookingReviewModal";
import { CustomerSelect, customerDisplayName } from "../../components/booking/CustomerSelect";
import { invalidBookingLines } from "../../components/booking/bookingLines";
import { useUserStore } from "../../store/userStore";
import { useShowMsilCode } from "../../hooks/useShowMsilCode";
import { isMsilCustomer, moqAppliesTo, effectiveMoq, isMultipleOf } from "../../utils/moq";
import { seesBookingReview, canUseSalesDesk } from "../../utils/permissions";
import { customersApi } from "../../services/users";
import toast from "react-hot-toast";

import { OrderTable } from "../../components/tables/OrderTable";
import { ProductSearchDropdown } from "../../components/ui";
import { CodeValue } from "../../components/ui/CodeValue";
import { Package, Hash, Tag, MessageSquare, Receipt, ArrowRight, Clock, Loader2 } from "lucide-react";

const units = (n) => `${n} unit${n === 1 ? "" : "s"}`;

const ValidityNotice = () => (
  <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
    <Clock size={14} className="text-red-500 shrink-0" />
    <p className="text-[11px] text-red-700 leading-relaxed">
      Booking valid for <span className="font-semibold">7 days</span>. Items are released if no PO is received.
    </p>
  </div>
);

export const CustomerOrders = () => {
  const [selectedProduct, setSelectedProduct] = useState(null);
  // The Confirm button's own step (re-reading live stock before the review),
  // kept apart from the cart's shared `loading`, which every list fetch and add
  // also sets — the button used to read "CONFIRMING…" during those.
  const [checkingStock, setCheckingStock] = useState(false);
  const [productSearchVal, setProductSearchVal] = useState("");
  const [showReview, setShowReview] = useState(false);
  // A customer's Confirm Booking books straight away (no review popup). The ref
  // is the synchronous double-click guard; state alone re-renders too late.
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const {
    items: cartItems,
    addItem,
    removeItem,
    removeItems,
    updateQuantity,
    fetchReservations,
    confirmBooking,
    loading,
    header,
    setPOHeader,
    getTotalQuantity,
    customer: actingCustomer,
    setCustomer,
  } = useCartStore();

  const { user } = useUserStore();
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * WHO THE BOOKING IS FOR.
   *
   * A customer books for themselves. A Sales Person or Admin (anyone who works
   * the sales desk) books ON BEHALF OF a customer chosen in the mandatory
   * Select Customer field, and until one is chosen nothing can be added or
   * confirmed. `bookingProfile` is the account whose rules apply — MOQ, MSIL,
   * brand — which is the customer's, never the staff member's.
   */
  const booksForOthers = canUseSalesDesk(user);
  const needsCustomer = booksForOthers && !actingCustomer;
  const bookingProfile = booksForOthers ? actingCustomer : user;

  // MOQ is enforced only for non-MSIL customers; MSIL customers are exempt.
  // Both the classification and the rule come from utils/moq.js, which mirrors
  // backend/utils/moq.js — re-deriving `customerCategory === "MSIL"` here is
  // what let a category stored as 'msil' reclassify an MSIL customer as
  // Customer and put them behind an MOQ they are exempt from.
  const isMsil = isMsilCustomer(bookingProfile);
  const showMsilCode = useShowMsilCode();
  const productMoq = effectiveMoq(bookingProfile, selectedProduct);
  const moqApplies = productMoq > 0;

  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm({
    defaultValues: {
      quantity: 0,
    },
  });

  const watchQuantity = watch("quantity");

  // Load existing reservations on mount. The desk's list is PER CUSTOMER, so
  // nothing is read until a customer is chosen (setCustomer reads it then).
  useEffect(() => {
    if (!needsCustomer) fetchReservations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchReservations]);

  // Back from "+ Add Customer": Customer Management returns here with the new
  // account's id, which is selected and then dropped from the URL so a reload
  // does not re-select it over a later choice.
  useEffect(() => {
    const id = searchParams.get("customer");
    if (!booksForOthers || !id) return;
    let cancelled = false;
    (async () => {
      try {
        const found = await customersApi.getById(id);
        if (cancelled) return;
        if (found) {
          await setCustomer(found);
          toast.success(`${customerDisplayName(found)} selected.`);
        } else {
          toast.error("That customer could not be found. Search for them to select them.");
        }
      } catch {
        if (!cancelled) toast.error("Could not load the customer. Search for them to select them.");
      } finally {
        if (!cancelled) {
          const next = new URLSearchParams(searchParams);
          next.delete("customer");
          setSearchParams(next, { replace: true });
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booksForOthers, searchParams.get("customer")]);

  const handleProductSelect = (product) => {
    setSelectedProduct(product);
    if (product) {
      setProductSearchVal(product.code);
      setValue("quantity", 0);
    } else {
      setProductSearchVal("");
    }
  };

  const handleAddToCart = async (data) => {
    if (needsCustomer) {
      toast.error("Select the customer this booking is for first.", { icon: "⚠️" });
      return;
    }
    if (!selectedProduct) {
      toast.error("Please Select Product", { icon: "⚠️" });
      return;
    }

    if (!Number.isInteger(data.quantity) || data.quantity < 1) {
      toast.error("Enter a valid whole-number quantity of at least 1", { icon: "❌" });
      return;
    }

    // non-MSIL customers book in multiples of the product's Multiple — the
    // same rule the server enforces (utils/moq.js), on every booking path.
    if (moqApplies && !isMultipleOf(data.quantity, productMoq)) {
      toast.error(`Quantity must be a multiple of ${productMoq}`, { icon: "❌" });
      return;
    }

    // Over-booking is allowed: any quantity may be booked even if it exceeds
    // available stock. Unfulfillable quantity becomes a Indent at confirmation.

    const res = await addItem(selectedProduct, data.quantity);

    if (res.success) {
      // A merged add updates an existing row instead of adding one, so say so —
      // an unchanged row count otherwise reads as the add having failed.
      toast.success(
        res.merged
          ? "Quantity added to this product's existing line in the Selection List"
          : "Product reserved and added to Selection List!",
      );
      setSelectedProduct(null);
      setProductSearchVal("");
      setValue("quantity", 0);
    } else {
      toast.error(res.error || "Failed to reserve item");
    }
  };

  const handleInlineQtyChange = async (productCode, qty) => {
    const res = await updateQuantity(productCode, qty);
    if (!res.success) {
      toast.error(res.error || "Quantity update failed");
    } else {
      toast.success("Reservation quantity updated");
    }
  };

  const handleRemoveCartItem = async (productCode) => {
    await removeItem(productCode);
    toast.success("Reservation cancelled and stock released");
  };

  const handleBulkRemove = async (reservationIds) => {
    const res = await removeItems(reservationIds);
    if (res.success) {
      toast.success(`${res.removed} item${res.removed === 1 ? "" : "s"} removed from Selection List`);
    } else {
      const detail = res.failed.map((f) => `${f.code}: ${f.error}`).slice(0, 3).join("; ");
      toast.error(
        `${res.removed} removed, ${res.failed.length} failed — ${detail}${res.failed.length > 3 ? "…" : ""}`,
        { duration: 7000 },
      );
    }
  };

  // The booking itself is made inside the review popup (Sales) or by
  // bookDirectly (customers); this only reports it, with a toast. The user
  // stays on this page — Booking History is in the menu. Worded from the server's `outcome` rather than guessed from totals: a
  // confirmation that fulfilled nothing created an INDENT and no booking, and
  // announcing that as a booking is what made the indent flow look broken.
  const handleBookingConfirmed = (result) => {
    setShowReview(false);
    const pending = result?.totals?.totalPending ?? 0;
    const outcome = result?.outcome || ((result?.totals?.totalConfirmed ?? 0) > 0 ? "booking" : "indent");
    // Named for the desk, so a salesperson booking for several customers in a
    // row can see which account each booking landed on.
    const forWhom = booksForOthers && result?.customer?.name ? ` for ${result.customer.name}` : "";
    toast.success(
      outcome === "indent"
        ? `Indent ${result?.indentId} raised${forWhom} for ${units(pending)}. No stock was available, so no booking was created.`
        : outcome === "booking+indent"
          ? `Booking ${result?.orderId} created${forWhom}. ${units(pending)} moved to Indent ${result?.indentId}.`
          : `Booking ${result?.orderId} created successfully${forWhom}.`,
      { duration: 6000 },
    );
  };

  // A customer is not shown the review popup (Sales only, 2026-11-03): their
  // Confirm Booking books the Selection List as it stands. No `reviewed` lines
  // are sent — the customer reviewed no split, so the server books what stock
  // covers and indents the rest, and the toast says which happened.
  const bookDirectly = async () => {
    if (submittingRef.current) return;
    const lines = useCartStore.getState().items;
    const invalid = invalidBookingLines(bookingProfile, lines);
    if (invalid.length) {
      toast.error(`Fix the quantity for ${invalid.map((l) => l.product.code).join(", ")} before confirming.`);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      handleBookingConfirmed(await confirmBooking());
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to confirm booking. Please try again.");
      await fetchReservations();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  // Confirm Booking (and a row's "Raise Indent"). For Sales it opens the review
  // popup, and nothing is booked until its own Confirm Booking is pressed;
  // reservations are re-read first so the popup shows live stock. A customer
  // books straight away — see bookDirectly.
  const handleOrderSubmission = async () => {
    if (needsCustomer) {
      toast.error("Select the customer this booking is for first.");
      return;
    }
    if (cartItems.length === 0) {
      toast.error("No reserved items to confirm.");
      return;
    }
    if (!seesBookingReview(user)) {
      await bookDirectly();
      return;
    }
    setCheckingStock(true);
    try {
      await fetchReservations();
    } finally {
      setCheckingStock(false);
    }
    setShowReview(true);
  };

  return (
    <div className="w-full h-auto p-4 lg:p-4 bg-slate-50/50 font-sans">
      {/* items-start: each card sizes to its own content, so growth in one
          panel (e.g. the Selection List) never stretches the other. */}
      <div className="grid grid-cols-1 lg:grid-cols-[38fr_62fr] gap-8 items-start">
        {/* LEFT PANEL: Create Booking */}
        <div className="flex flex-col gap-6 bg-white p-6 rounded-2xl border border-slate-200/60 shadow-sm relative overflow-hidden">
          {/* Subtle top border accent */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#1a5b9e] to-[#15467a]"></div>

          <div>
            <h1 className="text-2xl font-black text-slate-900 tracking-tight">
              Create Booking
            </h1>
          </div>

          <form onSubmit={handleSubmit(handleAddToCart)} className="flex flex-col gap-6">

            {/* SELECT CUSTOMER — Sales / Admin only, and mandatory for them:
                the booking is created on the chosen customer's account. */}
            {booksForOthers && (
              <CustomerSelect
                value={actingCustomer}
                onChange={(c) => { setCustomer(c); setSelectedProduct(null); setProductSearchVal(""); setValue("quantity", 0); }}
                disabled={loading || submitting || checkingStock}
              />
            )}

            {/* ITEM SKU CODE */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold text-slate-500 tracking-widest uppercase">
                Item SKU Code
              </label>
              <div className="rounded-xl shadow-sm transition-colors focus-within:ring-2 focus-within:ring-[#1a5b9e]/20">
                {needsCustomer ? (
                  // Not the live picker: a product chosen before the customer
                  // would be checked against nobody's brand access or MOQ.
                  <input
                    type="text"
                    disabled
                    value=""
                    readOnly
                    placeholder="Select a customer first"
                    aria-label="Item SKU Code"
                    className="w-full px-4 py-3 border border-slate-200/80 rounded-xl text-slate-800 font-semibold placeholder-slate-300 bg-slate-50/50 disabled:cursor-not-allowed"
                  />
                ) : (
                  <ProductSearchDropdown
                    placeholder={showMsilCode ? "Search by MSIL Code or SKU Code..." : "Search by SKU Code..."}
                    value={productSearchVal}
                    onChange={handleProductSelect}
                  />
                )}
              </div>
            </div>

            {/* PRODUCT DETAILS CARDS */}
            <div className={`grid ${showMsilCode ? "grid-cols-2" : "grid-cols-1"} gap-3`}>
              {/* MSIL Code — shown to Admins, MSIL customers (who order by it),
                  and anyone explicitly flagged with showMsilCode. */}
              {showMsilCode && (
                <div className="flex flex-col p-3.5 bg-slate-50/80 rounded-xl border border-slate-200/60 shadow-sm transition-all hover:shadow-md">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Hash size={14} className="text-[#1a5b9e]" />
                    <span className="text-[10px] font-bold text-slate-500 tracking-widest uppercase">MSIL Code</span>
                  </div>
                  {/* The customer re-checks this against their own paperwork
                      before booking, so it is shown whole however long it is. */}
                  {selectedProduct ? (
                    <CodeValue value={selectedProduct.msilCode} className="text-sm" />
                  ) : (
                    <span className="text-sm font-black text-slate-400">---</span>
                  )}
                </div>
              )}

              {/* CATEGORY */}
              <div className="flex flex-col p-3.5 bg-slate-50/80 rounded-xl border border-slate-200/60 shadow-sm transition-all hover:shadow-md">
                <div className="flex items-center gap-2 mb-1.5">
                  <Tag size={14} className="text-[#1a5b9e]" />
                  <span className="text-[10px] font-bold text-slate-500 tracking-widest uppercase">Category</span>
                </div>
                <span className={`text-sm font-black truncate ${selectedProduct && selectedProduct.category ? 'text-slate-800' : 'text-slate-400'}`}>
                  {selectedProduct ? (selectedProduct.category || "Uncategorized") : "---"}
                </span>
              </div>
            </div>

            {/* STOCK AVAILABILITY — shown just above Booking Qty. The Multiple
                column is shown only for non-MSIL customers; MSIL customers have none. */}
            <div className="flex flex-col p-4 bg-gradient-to-br from-slate-50 to-slate-100/50 rounded-xl border border-slate-200/80 shadow-sm relative overflow-hidden">
              <div className="absolute top-0 left-0 w-1 h-full bg-[#1a5b9e]/80 rounded-l-xl"></div>
              <div className="flex items-center gap-2 mb-3">
                <Package size={16} className="text-[#1a5b9e]" />
                <span className="text-xs font-bold text-slate-700 tracking-widest uppercase">Stock Availability</span>
              </div>
              <div className={`grid ${isMsil ? "grid-cols-2" : "grid-cols-3"} text-center divide-x divide-slate-200/80`}>
                <div className="flex flex-col items-center justify-center">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Available (AVL)</span>
                  <span className={`text-xl font-black ${selectedProduct ? "text-[#1a5b9e]" : "text-slate-300"}`}>
                    {selectedProduct ? (selectedProduct.availableStock ?? 0) : "-"}
                  </span>
                </div>
                {!isMsil && (
                  <div className="flex flex-col items-center justify-center">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Multiple</span>
                    <span className={`text-xl font-black ${selectedProduct ? "text-[#1a5b9e]" : "text-slate-300"}`}>
                      {selectedProduct ? (productMoq > 1 ? productMoq : "—") : "-"}
                    </span>
                  </div>
                )}
                <div className="flex flex-col items-center justify-center">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Remaining</span>
                  <span className={`text-xl font-black ${selectedProduct ? "text-slate-800" : "text-slate-300"}`}>
                    {selectedProduct ? (selectedProduct.availableStock ?? 0) - (Number.isInteger(watchQuantity) ? watchQuantity : 0) : "-"}
                  </span>
                </div>
              </div>
            </div>

            {/* QTY INPUT */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold text-slate-500 tracking-widest uppercase">
                Booking Qty {moqApplies && <span className="text-slate-400 normal-case">(Multiple {productMoq})</span>}
              </label>
              <div className="relative">
                <input
                  {...register("quantity", {
                    valueAsNumber: true,
                    validate: value => {
                      if (!Number.isInteger(value) || value < 1) return "Enter a whole-number quantity of at least 1";
                      if (moqApplies && !isMultipleOf(value, productMoq)) return `Quantity must be a multiple of ${productMoq}`;
                      return true;
                    },
                  })}
                  type="number"
                  step={moqApplies ? productMoq : 1}
                  min={moqApplies ? productMoq : 1}
                  placeholder="Enter Qty"
                  className="w-full px-4 py-3 border border-slate-200/80 rounded-xl outline-none focus:border-[#1a5b9e] focus:ring-2 focus:ring-[#1a5b9e]/20 text-slate-800 font-bold placeholder-slate-300 transition-all bg-slate-50/50 focus:bg-white"
                  disabled={!selectedProduct}
                />
              </div>
              {errors.quantity && <span className="text-xs text-red-500 mt-1 font-semibold">{errors.quantity.message}</span>}
              {/* Multiple reminder for Customer: quantity must be a multiple of it. */}
              {moqApplies && selectedProduct && (
                Number.isInteger(watchQuantity) && watchQuantity >= 1 && !isMultipleOf(watchQuantity, productMoq) ? (
                  <span className="text-xs text-red-500 mt-1 font-semibold">
                    Enter a multiple of {productMoq} (e.g. {productMoq}, {productMoq * 2}, {productMoq * 3}).
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-400 mt-1 font-medium">
                    Book in multiples of {productMoq} — e.g. {productMoq}, {productMoq * 2}, {productMoq * 3}.
                  </span>
                )
              )}
              {selectedProduct && watchQuantity > selectedProduct.availableStock && (
                <span className="text-xs text-amber-600 mt-1 font-semibold">
                  Exceeds available quantity (AVL {selectedProduct.availableStock}). {watchQuantity - selectedProduct.availableStock} unit(s) will move to Indent on confirmation.
                </span>
              )}
            </div>

            {/* ADD TO LIST BUTTON */}
            <button
              type="submit"
              disabled={loading || !selectedProduct || !Number.isInteger(watchQuantity) || watchQuantity < 1 || (moqApplies && !isMultipleOf(watchQuantity, productMoq))}
              className="w-full py-3.5 mt-2 bg-gradient-to-r from-[#1a5b9e] to-[#15467a] hover:from-[#15467a] hover:to-[#0f345a] text-white font-bold rounded-xl flex items-center justify-center gap-2 transition-all shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed tracking-wider text-sm active:scale-[0.98]"
            >
              <span className="text-lg font-light leading-none mb-0.5">+</span> ADD TO LIST
            </button>
          </form>
        </div>

        {/* RIGHT PANEL: Selection List */}
        <div className="flex flex-col gap-6 bg-white p-6 rounded-2xl border border-slate-200/60 shadow-sm relative overflow-hidden">
          {/* Subtle top border accent */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500 to-teal-500"></div>

          <div>
            <h1 className="text-2xl font-black text-slate-900 tracking-tight">
              Selection List
            </h1>
            {booksForOthers && (
              <p className="text-xs font-semibold text-slate-500 mt-1" data-testid="selection-list-for">
                {actingCustomer
                  ? <>For <span className="text-slate-800">{customerDisplayName(actingCustomer)}</span>{actingCustomer.company ? ` · ${actingCustomer.company}` : ""}</>
                  : "Select a customer to start their booking."}
              </p>
            )}
          </div>

          <div className="flex flex-col">
            <div className="w-full">
              <OrderTable
                items={needsCustomer ? [] : cartItems}
                onUpdateQty={handleInlineQtyChange}
                onRemoveItem={handleRemoveCartItem}
                onBulkRemove={handleBulkRemove}
                onRaiseIndent={handleOrderSubmission}
                enforceMoq={moqAppliesTo(bookingProfile)}
              />
            </div>

            <div className="mt-6 border-t border-slate-200/80 pt-6">
              
              {/* ORDER DETAILS & FINANCIAL SUMMARY CARDS */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                <div className="flex flex-col gap-4 bg-slate-50/80 border border-slate-200/60 rounded-xl p-5 shadow-sm">
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <MessageSquare size={14} className="text-slate-400" />
                      <label className="text-[10px] font-bold text-slate-500 tracking-widest uppercase">Remarks (Optional)</label>
                    </div>
                    <input
                      type="text"
                      placeholder="Any specific instructions..."
                      value={header.remarks}
                      onChange={(e) => setPOHeader({ remarks: e.target.value })}
                      className="w-full px-3.5 py-2 border border-slate-200/80 rounded-lg outline-none focus:border-[#1a5b9e] focus:ring-2 focus:ring-[#1a5b9e]/20 text-sm text-slate-800 font-semibold bg-white transition-all shadow-sm"
                    />
                  </div>
                </div>

                <div className=" bg-slate-50/80 border border-slate-200/60  rounded-xl p-5 shadow-sm flex flex-col justify-center relative overflow-hidden">
                  <div className="absolute right-0 top-0 opacity-10 pointer-events-none">
                    <Receipt size={120} className="text-white -mr-6 -mt-6" />
                  </div>
                  
                  <div className="relative z-10">
                    <div className="flex justify-between text-xs font-bold text-slate-400 mb-2.5">
                      <span>Total Items:</span>
                      <span className="text-white bg-slate-700/50 px-2 py-0.5 rounded-md">{cartItems.length}</span>
                    </div>
                    <div className="flex justify-between text-xs font-bold text-slate-400 mb-2.5">
                      <span>Total Quantity:</span>
                      <span className="text-white bg-slate-700/50 px-2 py-0.5 rounded-md">{getTotalQuantity()}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                
                <button
                  onClick={handleOrderSubmission}
                  disabled={needsCustomer || loading || checkingStock || submitting || cartItems.length === 0}
                  aria-busy={checkingStock || submitting}
                  className="w-full py-4 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-black rounded-xl flex items-center justify-center gap-3 transition-all shadow-[0_4px_14px_0_rgba(16,185,129,0.39)] hover:shadow-[0_6px_20px_rgba(16,185,129,0.23)] active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 disabled:hover:shadow-none disabled:cursor-not-allowed mb-4"
                >
                  <div className="flex flex-col text-left">
                    <span className="tracking-widest text-sm mb-0.5">{checkingStock ? "CHECKING STOCK…" : submitting ? "CONFIRMING…" : "CONFIRM BOOKING"}</span>
                    <span className="text-[10px] text-green-100 font-medium tracking-wide uppercase opacity-90">
                      {checkingStock ? "Reading live availability" : submitting ? "Submitting your booking" : loading ? "Updating your list…" : "Submit Booking to ERP"}
                    </span>
                  </div>
                  {checkingStock || submitting || loading
                    ? <Loader2 size={22} className="ml-2 animate-spin opacity-80" />
                    : <ArrowRight size={24} className="ml-2 opacity-80" />}
                </button>

                <ValidityNotice />
              </div>
            </div>
          </div>
        </div>
      </div>

      <BookingReviewModal
        isOpen={showReview}
        onClose={() => setShowReview(false)}
        onConfirmed={handleBookingConfirmed}
      />
    </div>
  );
};

export default CustomerOrders;