import React from "react";
import { Loader2 } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export const Button = React.forwardRef(
  (
    {
      className,
      variant = "primary",
      size = "md",
      loading,
      children,
      disabled,
      ...props
    },
    ref,
  ) => {
    const baseStyles =
      "inline-flex items-center justify-center font-medium rounded-lg transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:pointer-events-none active:scale-[0.98]";

    const variants = {
      primary:
        "bg-primary-600 hover:bg-primary-700 text-white shadow-enterprise",
      secondary:
        "bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200",
      danger: "bg-error-500 hover:bg-error-600 text-white shadow-enterprise",
      outline:
        "bg-transparent border border-slate-300 hover:bg-slate-50 text-slate-700",
      ghost: "bg-transparent hover:bg-slate-100 text-slate-600",
    };

    const sizes = {
      // Compact actions that sit inside toolbars, bulk-action bars and pagers.
      // Missing until now, so every `size="xs"` in the inventory screens fell
      // through to `undefined` and rendered with NO padding at all — the text
      // sat flush against the button edge.
      xs: "px-2.5 py-1 text-[11px]",
      sm: "px-3 py-1.5 text-xs",
      md: "px-4 py-2 text-sm",
      lg: "px-5 py-2.5 text-base",
    };

    // A mistyped size or variant produces an unstyled button rather than an
    // error, which is exactly how the missing `xs` above went unnoticed. Fail
    // loudly in development instead.
    if (import.meta.env?.DEV) {
      if (size && !sizes[size]) {
        console.error(
          `<Button size="${size}"> is not a known size. Expected one of: ${Object.keys(sizes).join(", ")}. ` +
          "The button will render without padding or a text size.",
        );
      }
      if (variant && !variants[variant]) {
        console.error(
          `<Button variant="${variant}"> is not a known variant. Expected one of: ${Object.keys(variants).join(", ")}. ` +
          "The button will render without a background or text colour.",
        );
      }
    }

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={twMerge(
          clsx(baseStyles, variants[variant], sizes[size], className),
        )}
        {...props}
      >
        {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
        {children}
      </button>
    );
  },
);

Button.displayName = "Button";
