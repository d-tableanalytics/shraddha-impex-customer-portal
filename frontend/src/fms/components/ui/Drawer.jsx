import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * A right-hand side panel.
 *
 * `subheader` and `footer` are optional slots that sit OUTSIDE the scrolling
 * body — a tab strip that scrolls out of reach, or a pair of primary actions
 * that can only be pressed after scrolling a long panel to the bottom, are the
 * two ways this component is otherwise misused. Both default to nothing, so a
 * caller that passes neither renders exactly as before.
 */
export const Drawer = ({
  isOpen,
  onClose,
  title,
  subheader,
  footer,
  children,
  maxWidth = "max-w-md",
  bodyClassName = "p-6",
}) => {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
          />

          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className={`relative w-full ${maxWidth} h-full bg-white shadow-enterprise-lg border-l border-slate-200 flex flex-col`}
          >
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3 bg-slate-50/50">
              <h3 className="text-base font-semibold text-slate-900 min-w-0">
                {title}
              </h3>
              <button
                onClick={onClose}
                aria-label="Close"
                className="shrink-0 p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {subheader && (
              <div className="px-6 border-b border-slate-100 shrink-0">{subheader}</div>
            )}

            <div className={`${bodyClassName} overflow-y-auto flex-1`}>{children}</div>

            {footer && (
              <div className="px-6 py-4 border-t border-slate-200 bg-slate-50/60 shrink-0">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
};
