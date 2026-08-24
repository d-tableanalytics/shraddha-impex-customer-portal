import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { useCartStore } from "../../store/cartStore";
import { ReviewIndentModal } from "../../components/booking/ReviewIndentModal";
import { computeReview } from "../../utils/bookingReview";
import { useUserStore } from "../../store/userStore";
import { useShowMsilCode } from "../../hooks/useShowMsilCode";
import { isMsilCustomer, moqAppliesTo, effectiveMoq } from "../../utils/moq";
import toast from "react-hot-toast";

import { OrderTable } from "../../components/tables/OrderTable";
import { ProductSearchDropdown } from "../../components/ui";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { Package, Hash, Tag, MessageSquare, Receipt, ArrowRight, AlertTriangle, Clock, PackageCheck } from "lucide-react";

const ValidityNotice = () => (
  <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
    <Clock size={14} className="text-red-500 shrink-0" />
    <p className="text-[11px] text-red-700 leading-relaxed">
      Booking valid for <span className="font-semibold">7 days</span>. Items are released if no PO is received.
    </p>
  </div>
);

export const CustomerOrders = () => {
  const navigate = useNavigate();
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [productSearchVal, setProductSearchVal] = useState("");
  const [showIndentConfirm, setShowIndentConfirm] = useState(false);
  const [showBookingConfirm, setShowBookingConfirm] = useState(false);
  const [summary, setSummary] = useState(null);

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
  } = useCartStore();

  const { user } = useUserStore();

  // MOQ is enforced only for non-MSIL customers; MSIL customers are exempt.
  // Both the classification and the rule come from utils/moq.js, which mirrors
  // backend/utils/moq.js — re-deriving `customerCategory === "MSIL"` here is
  // what let a category stored as 'msil' reclassify an MSIL customer as
  // Customer and put them behind an MOQ they are exempt from.
  const isMsil = isMsilCustomer(user);
  const showMsilCode = useShowMsilCode();
  const productMoq = effectiveMoq(user, selectedProduct);
  const moqApplies = productMoq > 0;

  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm({
    defaultValues: {
      quantity: 0,
    },
  });

  const watchQuantity = watch("quantity");

  // Load existing reservations on mount
  useEffect(() => {
    fetchReservations();
  }, [fetchReservations]);

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
    if (!selectedProduct) {
      toast.error("Please Select Product", { icon: "⚠️" });
      return;
    }

    if (!Number.isInteger(data.quantity) || data.quantity < 1) {
      toast.error("Enter a valid whole-number quantity of at least 1", { icon: "❌" });
      return;
    }

    // non-MSIL customers must book at least the product's MOQ. It is a
    // minimum, not a pack size — the multiple-of check that used to sit here
    // was never enforced by the server, so it refused quantities the same
    // customer could push through Bulk Upload unchallenged.
    if (moqApplies && data.quantity < productMoq) {
      toast.error(`Quantity must be at least the MOQ (${productMoq})`, { icon: "❌" });
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

  const review = computeReview(cartItems);

  // "Raise Indent" from a Selection List row: opens the Review Indent popup so
  // the user can confirm the booking (the shortfall becomes a Indent).
  const handleRaiseIndent = () => {
    setShowIndentConfirm(true);
  };

  const runConfirmBooking = async () => {
    setShowIndentConfirm(false);
    setShowBookingConfirm(false);
    try {
      const result = await confirmBooking();
      const totals = result?.totals;
      // Show the confirmation summary popup with confirmed vs pending-indent
      // counts. `outcome` comes from the server rather than being guessed here:
      // a confirmation that fulfilled nothing created an INDENT and no booking,
      // and heading that popup "Booking Confirmed" — then sending the customer
      // to Booking History to find nothing — is what made the indent flow look
      // broken from the outside.
      setSummary({
        outcome: result?.outcome || ((totals?.totalConfirmed ?? 0) > 0 ? "booking" : "indent"),
        orderId: result?.orderId || "",
        poNumber: result?.poNumber || "",
        indentId: result?.indentId || "",
        confirmed: totals?.totalConfirmed ?? 0,
        pending: totals?.totalPending ?? 0,
        lines: (result?.summary || []).length,
      });
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to confirm booking.");
    }
  };

  const handleOrderSubmission = async () => {
    if (cartItems.length === 0) {
      toast.error("No reserved items to confirm.");
      return;
    }

    // Refresh reservations so the shortfall check runs on current stock, then
    // show the Review Indent popup before finalising the booking.
    await fetchReservations();
    const freshReview = computeReview(useCartStore.getState().items);
    if (freshReview.pending.length > 0) {
      setShowIndentConfirm(true);
      return;
    }
    // No indent — still confirm the 7-day validity note before booking.
    setShowBookingConfirm(true);
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
            
            {/* ITEM SKU CODE */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold text-slate-500 tracking-widest uppercase">
                Item SKU Code
              </label>
              <div className="rounded-xl shadow-sm transition-colors focus-within:ring-2 focus-within:ring-[#1a5b9e]/20">
                <ProductSearchDropdown
                  placeholder={showMsilCode ? "Search by MSIL Code or SKU Code..." : "Search by SKU Code..."}
                  value={productSearchVal}
                  onChange={handleProductSelect}
                />
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
                  <span className={`text-sm font-black ${selectedProduct?.msilCode ? "text-slate-800" : "text-slate-400"}`}>
                    {selectedProduct ? (selectedProduct.msilCode || "—") : "---"}
                  </span>
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

            {/* STOCK AVAILABILITY — shown just above Booking Qty. MOQ column is
                shown only for non-MSIL customers; MSIL customers have no MOQ. */}
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
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">MOQ</span>
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
                Booking Qty {moqApplies && <span className="text-slate-400 normal-case">(MOQ {productMoq})</span>}
              </label>
              <div className="relative">
                <input
                  {...register("quantity", {
                    valueAsNumber: true,
                    validate: value => {
                      if (!Number.isInteger(value) || value < 1) return "Enter a whole-number quantity of at least 1";
                      if (moqApplies && value < productMoq) return `Quantity must be at least the MOQ (${productMoq})`;
                      return true;
                    },
                  })}
                  type="number"
                  step={1}
                  min={moqApplies ? productMoq : 1}
                  placeholder="Enter Qty"
                  className="w-full px-4 py-3 border border-slate-200/80 rounded-xl outline-none focus:border-[#1a5b9e] focus:ring-2 focus:ring-[#1a5b9e]/20 text-slate-800 font-bold placeholder-slate-300 transition-all bg-slate-50/50 focus:bg-white"
                  disabled={!selectedProduct}
                />
              </div>
              {errors.quantity && <span className="text-xs text-red-500 mt-1 font-semibold">{errors.quantity.message}</span>}
              {/* MOQ reminder for Customer: quantity must be at least the MOQ. */}
              {moqApplies && selectedProduct && (
                Number.isInteger(watchQuantity) && watchQuantity >= 1 && watchQuantity < productMoq ? (
                  <span className="text-xs text-red-500 mt-1 font-semibold">
                    Enter {productMoq} or more units (MOQ {productMoq}).
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-400 mt-1 font-medium">
                    Minimum {productMoq} units — enter {productMoq} or more.
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
              disabled={loading || !selectedProduct || !Number.isInteger(watchQuantity) || watchQuantity < 1 || (moqApplies && watchQuantity < productMoq)}
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
          </div>

          <div className="flex flex-col">
            <div className="w-full">
              <OrderTable
                items={cartItems}
                onUpdateQty={handleInlineQtyChange}
                onRemoveItem={handleRemoveCartItem}
                onBulkRemove={handleBulkRemove}
                onRaiseIndent={handleRaiseIndent}
                enforceMoq={moqAppliesTo(user)}
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
                  disabled={loading || cartItems.length === 0}
                  className="w-full py-4 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-black rounded-xl flex items-center justify-center gap-3 transition-all shadow-[0_4px_14px_0_rgba(16,185,129,0.39)] hover:shadow-[0_6px_20px_rgba(16,185,129,0.23)] active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 disabled:hover:shadow-none disabled:cursor-not-allowed mb-4"
                >
                  <div className="flex flex-col text-left">
                    <span className="tracking-widest text-sm mb-0.5">{loading ? "CONFIRMING..." : "CONFIRM BOOKING"}</span>
                    <span className="text-[10px] text-green-100 font-medium tracking-wide uppercase opacity-90">{loading ? "Please wait" : "Submit Booking to ERP"}</span>
                  </div>
                  <ArrowRight size={24} className="ml-2 opacity-80" />
                </button>

                <ValidityNotice />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Review Indent / Confirm Booking — the shared popup. It decides which
          of the two it is from whether anything is short, so this screen and
          Bulk Upload cannot drift apart. */}
      <ReviewIndentModal
        isOpen={showIndentConfirm || showBookingConfirm}
        onClose={() => { setShowIndentConfirm(false); setShowBookingConfirm(false); }}
        onConfirm={runConfirmBooking}
        review={review}
        loading={loading}
        itemCount={cartItems.length}
        unitCount={getTotalQuantity()}
      />

      {/* CONFIRMATION SUMMARY POPUP — named after what was actually created:
          a booking, an indent, or both. Each links to the history that holds
          it, so nobody is sent to Booking History to look for an indent. */}
      <Modal
        isOpen={!!summary}
        onClose={() => setSummary(null)}
        title={
          summary?.outcome === "indent"
            ? "Indent Raised"
            : summary?.outcome === "booking+indent"
              ? "Booking Confirmed with Indent"
              : "Booking Confirmed"
        }
        size="sm"
      >
        {summary && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className={`w-11 h-11 rounded-full flex items-center justify-center ${
                summary.outcome === "indent" ? "bg-amber-50" : "bg-emerald-50"
              }`}>
                {summary.outcome === "indent"
                  ? <AlertTriangle size={22} className="text-amber-600" />
                  : <PackageCheck size={22} className="text-emerald-600" />}
              </div>
              <div>
                <p className="text-sm font-bold text-slate-800">
                  {summary.outcome === "indent"
                    ? `Indent ${summary.indentId}`
                    : `Booking ${summary.orderId}`}
                </p>
                <p className="text-xs text-slate-500">PO {summary.poNumber}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-center">
                <p className="text-2xl font-black text-emerald-700">{summary.confirmed}</p>
                <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-wider mt-1">Units Confirmed</p>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-center">
                <p className="text-2xl font-black text-amber-700">{summary.pending}</p>
                <p className="text-[10px] font-bold text-amber-600 uppercase tracking-wider mt-1">Units → Indent</p>
              </div>
            </div>

            {summary.pending > 0 && (
              <p className="text-xs text-slate-500 leading-relaxed">
                {summary.outcome === "indent"
                  ? "None of the requested quantity was in stock, so no booking was created."
                  : "Part of the booking could not be fulfilled from stock."}{" "}
                Indent <span className="font-semibold text-amber-700">{summary.indentId}</span> is
                tracked in Indent History and fulfilled when material is inwarded. We have emailed
                you the details.
              </p>
            )}

            <div className="flex justify-end gap-3 mt-1">
              {/* Indent-only or combined: show Indent History button */}
              {(summary.outcome === "indent" || summary.outcome === "booking+indent" || summary.pending > 0) && (
                <Button
                  variant={summary.outcome === "indent" ? "primary" : "secondary"}
                  onClick={() => { setSummary(null); navigate("/orders/indent-history"); }}
                >
                  View Indent History
                </Button>
              )}
              {/* Booking-only or combined: show Booking History button.
                  Never shown for indent-only outcomes. */}
              {summary.outcome !== "indent" && (summary.confirmed > 0 || summary.outcome === "booking" || summary.outcome === "booking+indent") && (
                <Button variant="primary" onClick={() => { setSummary(null); navigate("/orders/history"); }}>
                  View Booking History
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default CustomerOrders;