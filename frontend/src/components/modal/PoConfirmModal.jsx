import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, User, MapPin, Building2, Store, FileText, Hash, Calendar,
  CreditCard, Clock, FileCheck2, Loader2, ShieldCheck, Phone, Navigation
} from "lucide-react";
import { ERPButton } from "../ui/ERPButton";

export const PoConfirmModal = ({ isOpen, onClose, onConfirm, booking, initialPoNumber, saving }) => {
  const [formData, setFormData] = useState({
    customerName: "",
    phoneNumber: "",
    location: "",
    shippingAddress: "",
    billingAddress: "",
    shopNumber: "",
    gstCode: "",
    vendorCode: "",
    poNumber: "",
    poDate: "",
    paymentTerm: "Net 30",
    promiseDate: "",
  });

  useEffect(() => {
    if (isOpen && booking) {
      const today = new Date().toISOString().split("T")[0];
      const defaultPromise = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

      setFormData({
        customerName: booking.customer || booking.customerName || "",
        // Seeded from the booking so the desk confirms rather than retypes: the
        // phone comes off the customer's account at booking time and the
        // location off the delivery address they gave.
        phoneNumber: booking.phoneNumber || "",
        location: booking.location || "",
        shippingAddress: booking.shippingAddress || booking.location || "",
        billingAddress: booking.billingAddress || booking.shippingAddress || booking.location || "",
        shopNumber: booking.shopNumber || "",
        gstCode: booking.gstCode || "",
        vendorCode: booking.vendorCode || "",
        poNumber: initialPoNumber !== undefined ? initialPoNumber : (booking.poNumber || ""),
        poDate: booking.poDate ? new Date(booking.poDate).toISOString().split("T")[0] : today,
        paymentTerm: booking.paymentTerm || "Net 30",
        promiseDate: booking.promiseDate ? new Date(booking.promiseDate).toISOString().split("T")[0] : defaultPromise,
      });
    }
  }, [isOpen, booking, initialPoNumber]);

  if (!isOpen) return null;

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onConfirm(formData);
  };

  const inputClass =
    "w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 transition-all placeholder:text-slate-400";
  const labelClass = "block text-xs font-bold text-slate-600 mb-1.5 flex items-center gap-1.5";

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm cursor-pointer"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] z-10 border border-slate-100"
        >
          {/* Header.
              The brand blue the rest of the ERP uses — the same
              #1a5b9e -> #15467a gradient as the Create Booking accent bar and
              the primary call-to-action. This was slate-900, a near-black that
              matched nothing else in the app and read as a different product.
              The inner elements are tinted with white alpha rather than the
              primary-* scale, which was picked for contrast against the old
              near-black and is too dim against this blue. */}
          <div className="px-6 py-4 bg-gradient-to-r from-[#1a5b9e] to-[#15467a] text-white flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-white/15 border border-white/25 flex items-center justify-center text-white">
                <FileCheck2 size={20} />
              </div>
              <div>
                <h3 className="text-base font-black tracking-tight text-white flex items-center gap-2">
                  Confirm &amp; Lock Purchase Order
                </h3>
                <p className="text-xs text-blue-100">
                  Booking Reference: <span className="font-mono text-white font-bold">{booking?.orderId}</span>
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 text-white/70 hover:text-white hover:bg-white/15 rounded-lg transition-colors"
            >
              <X size={20} />
            </button>
          </div>

          {/* Banner Info */}
          <div className="px-6 py-3 bg-amber-50/80 border-b border-amber-200/60 flex items-center gap-2 text-xs text-amber-900">
            <ShieldCheck size={16} className="text-amber-600 shrink-0" />
            <span>
              Review and update the purchase order details below. Confirming will lock this booking and reserve inventory.
            </span>
          </div>

          {/* Form Content */}
          <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

              {/* 1. Customer Name */}
              <div className="md:col-span-2">
                <label className={labelClass}>
                  <User size={14} className="text-primary-600" /> Customer Name
                </label>
                <input
                  type="text"
                  required
                  value={formData.customerName}
                  onChange={(e) => handleChange("customerName", e.target.value)}
                  placeholder="Enter customer name"
                  className={inputClass}
                />
              </div>

              {/* 2. Phone Number — printed on the pick list beside the
                  location, so the two are collected together here. */}
              <div>
                <label className={labelClass}>
                  <Phone size={14} className="text-emerald-600" /> Phone Number
                </label>
                <input
                  type="tel"
                  value={formData.phoneNumber}
                  onChange={(e) => handleChange("phoneNumber", e.target.value)}
                  placeholder="e.g. +91 98765 43210"
                  className={inputClass}
                />
              </div>

              {/* 3. Location */}
              <div>
                <label className={labelClass}>
                  <Navigation size={14} className="text-rose-600" /> Location
                </label>
                <input
                  type="text"
                  value={formData.location}
                  onChange={(e) => handleChange("location", e.target.value)}
                  placeholder="e.g. Okhla Phase II, New Delhi"
                  className={inputClass}
                />
              </div>

              {/* 4. Shipping Address */}
              <div>
                <label className={labelClass}>
                  <MapPin size={14} className="text-blue-600" /> Shipping Address
                </label>
                <textarea
                  rows={2}
                  value={formData.shippingAddress}
                  onChange={(e) => handleChange("shippingAddress", e.target.value)}
                  placeholder="Enter shipping address"
                  className={`${inputClass} resize-none`}
                />
              </div>

              {/* 5. Billing Address */}
              <div>
                <label className={labelClass}>
                  <Building2 size={14} className="text-indigo-600" /> Billing Address
                </label>
                <textarea
                  rows={2}
                  value={formData.billingAddress}
                  onChange={(e) => handleChange("billingAddress", e.target.value)}
                  placeholder="Enter billing address"
                  className={`${inputClass} resize-none`}
                />
              </div>

              {/* 6. Shop Number */}
              <div>
                <label className={labelClass}>
                  <Store size={14} className="text-emerald-600" /> Shop Number
                </label>
                <input
                  type="text"
                  value={formData.shopNumber}
                  onChange={(e) => handleChange("shopNumber", e.target.value)}
                  placeholder="e.g. Shop 102 / Plot 4"
                  className={inputClass}
                />
              </div>

              {/* 7. GST Code */}
              <div>
                <label className={labelClass}>
                  <FileText size={14} className="text-amber-600" /> GST Code / Number
                </label>
                <input
                  type="text"
                  value={formData.gstCode}
                  onChange={(e) => handleChange("gstCode", e.target.value)}
                  placeholder="e.g. 07AAAAA0000A1Z5"
                  className={`${inputClass} uppercase`}
                />
              </div>

              {/* 8. Vendor Code */}
              <div>
                <label className={labelClass}>
                  <Hash size={14} className="text-violet-600" /> Vendor Code
                </label>
                <input
                  type="text"
                  value={formData.vendorCode}
                  onChange={(e) => handleChange("vendorCode", e.target.value)}
                  placeholder="e.g. VEND-9921"
                  className={inputClass}
                />
              </div>

              {/* 9. PO Number */}
              <div>
                <label className={labelClass}>
                  <FileCheck2 size={14} className="text-primary-600" /> PO Number
                </label>
                <input
                  type="text"
                  value={formData.poNumber}
                  onChange={(e) => handleChange("poNumber", e.target.value)}
                  placeholder="Leave blank for auto-generate"
                  className={`${inputClass} font-mono`}
                />
              </div>

              {/* 10. PO Date */}
              <div>
                <label className={labelClass}>
                  <Calendar size={14} className="text-sky-600" /> PO Date
                </label>
                <input
                  type="date"
                  required
                  value={formData.poDate}
                  onChange={(e) => handleChange("poDate", e.target.value)}
                  className={inputClass}
                />
              </div>

              {/* 11. Payment Term */}
              <div>
                <label className={labelClass}>
                  <CreditCard size={14} className="text-teal-600" /> Payment Term
                </label>
                <select
                  value={formData.paymentTerm}
                  onChange={(e) => handleChange("paymentTerm", e.target.value)}
                  className={inputClass}
                >
                  <option value="Immediate">Immediate / Advance</option>
                  <option value="Net 7">Net 7 Days</option>
                  <option value="Net 15">Net 15 Days</option>
                  <option value="Net 30">Net 30 Days</option>
                  <option value="Net 45">Net 45 Days</option>
                  <option value="Net 60">Net 60 Days</option>
                  <option value="Custom">Custom</option>
                </select>
              </div>

              {/* 12. Promise Date */}
              <div>
                <label className={labelClass}>
                  <Clock size={14} className="text-rose-600" /> Promise Date
                </label>
                <input
                  type="date"
                  value={formData.promiseDate}
                  onChange={(e) => handleChange("promiseDate", e.target.value)}
                  className={inputClass}
                />
              </div>

            </div>

            {/* Modal Actions */}
            <div className="pt-4 border-t border-slate-100 flex items-center justify-end gap-3 shrink-0">
              <ERPButton variant="outline" type="button" onClick={onClose} disabled={saving}>
                Cancel
              </ERPButton>
              <ERPButton variant="primary" type="submit" disabled={saving}>
                {saving ? <Loader2 size={16} className="mr-2 animate-spin" /> : <FileCheck2 size={16} className="mr-2" />}
                Confirm &amp; Lock PO
              </ERPButton>
            </div>
          </form>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default PoConfirmModal;
