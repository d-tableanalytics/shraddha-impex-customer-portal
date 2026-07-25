import { useState } from "react";
import { Mail, HelpCircle, Copy, Check, ChevronDown, ChevronUp } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import toast from "react-hot-toast";
import { PageHeader } from "../../components/common/PageHeader";
import { Card, CardContent } from "../../components/ui/Card";

export const Help = () => {
  const [copied, setCopied] = useState(false);
  const [openFaq, setOpenFaq] = useState(null);

  const supportEmail = "support@shraddhaimpex.net";

  const handleCopyEmail = () => {
    navigator.clipboard.writeText(supportEmail);
    setCopied(true);
    toast.success("Email address copied to clipboard!");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleEmailClick = (e) => {
    e.preventDefault();
    window.location.href = `mailto:${supportEmail}`;
    navigator.clipboard.writeText(supportEmail);
    toast.success("Opening email client (email copied to clipboard!)");
  };

  const faqs = [
    {
      question: "How do I create a new booking?",
      answer: "Navigate to the 'Create Booking' tab in the sidebar. Select a product, enter your desired quantity, provide the PO number, delivery location, and optional remarks, then click 'Confirm Booking' to finalize.",
    },
    {
      question: "What is an Indent and when is it raised?",
      answer: "If your booked quantity exceeds the current available stock for a product, the shortfall is converted into a 'Indent' upon booking confirmation. Once new stock arrives, administrators can release these indents back to your active selection list for confirmation.",
    },
    {
      question: "Can I upload bookings in bulk?",
      answer: "Yes, you can upload bookings in bulk using the 'Bulk Upload' page. Download the template Excel sheet, fill in the SKU Code and Quantity columns, upload the file, and then verify and confirm the entries in the selection list.",
    },
    {
      question: "How do I edit or delete my bookings?",
      answer: "Once a booking is confirmed, it is locked in the system. If you need to make changes or cancel an existing booking, please contact our support team at support@shraddhaimpex.net with your Booking ID.",
    },
    {
      question: "How long is a reserved booking valid for?",
      answer: "Standard product reservations in your selection list are valid for a default window of 7 days. If not confirmed as a booking within this period, they are automatically cancelled and marked as Expired.",
    },
  ];

  return (
    <div className="flex flex-col gap-6 select-none">
      <PageHeader title="Help & Support" />
      <p className="text-slate-600 -mt-2 text-sm">
        Get assistance, explore tutorials, or contact support.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Support Card */}
        <div className="lg:col-span-1">
          <Card className="bg-linear-to-b from-slate-900 via-primary-950 to-slate-900 border-none text-white h-full relative overflow-hidden flex flex-col justify-between">
            {/* Background design elements */}
            <div className="absolute top-0 right-0 w-32 h-32 bg-primary-500/10 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute -bottom-8 -left-8 w-40 h-40 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />

            <CardContent className="flex-1 flex flex-col justify-between p-8 relative z-10">
              <div className="flex flex-col gap-6">
                <div className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center text-primary-400 border border-white/15 shadow-inner">
                  <Mail size={24} />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white tracking-tight">Need Assistance?</h3>
                  <p className="text-sm text-slate-300 mt-2 leading-relaxed">
                    Have questions about your bookings, indents, or inventory? Our support team is ready to help you resolve any issues.
                  </p>
                </div>
              </div>

              <div className="mt-8 flex flex-col gap-4">
                <div className="bg-white/5 border border-white/10 rounded-xl p-4 flex flex-col gap-1.5 backdrop-blur-xs">
                  <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Email Address</span>
                  <span className="text-sm font-semibold text-primary-300 break-all select-all">{supportEmail}</span>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={handleEmailClick}
                    className="flex-1 inline-flex items-center justify-center gap-2 bg-primary-600 hover:bg-primary-500 text-white px-4 py-2.5 rounded-xl font-bold text-sm shadow-md shadow-primary-900/30 transition-all active:scale-98 cursor-pointer"
                  >
                    Email Us
                  </button>
                  <button
                    onClick={handleCopyEmail}
                    className="p-2.5 bg-white/10 hover:bg-white/15 border border-white/10 rounded-xl transition-all text-white flex items-center justify-center active:scale-95"
                    title="Copy Email Address"
                  >
                    {copied ? <Check size={18} className="text-emerald-400 animate-scale" /> : <Copy size={18} />}
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* FAQs */}
        <div className="lg:col-span-2">
          <Card className="h-full bg-white border border-slate-200">
            <CardContent className="p-8">
              <div className="flex items-center gap-2 mb-6">
                <HelpCircle className="text-primary-600" size={20} />
                <h3 className="text-lg font-bold text-slate-800 tracking-tight">Frequently Asked Questions</h3>
              </div>

              <div className="divide-y divide-slate-100">
                {faqs.map((faq, index) => {
                  const isOpen = openFaq === index;
                  return (
                    <div key={index} className="py-4 first:pt-0 last:pb-0">
                      <button
                        onClick={() => setOpenFaq(isOpen ? null : index)}
                        className="w-full flex items-center justify-between text-left font-semibold text-slate-700 hover:text-primary-700 transition-colors py-2 focus:outline-none"
                      >
                        <span className="text-sm pr-4">{faq.question}</span>
                        {isOpen ? <ChevronUp size={16} className="text-slate-400 shrink-0" /> : <ChevronDown size={16} className="text-slate-400 shrink-0" />}
                      </button>

                      <AnimatePresence initial={false}>
                        {isOpen && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <p className="text-xs text-slate-500 leading-relaxed mt-2 pl-1 select-text">
                              {faq.answer}
                            </p>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Help;
