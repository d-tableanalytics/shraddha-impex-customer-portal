import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export const Badge = ({
  className,
  variant = "neutral",
  children,
  ...props
}) => {
  const baseStyles =
    "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold select-none border transition-colors";

  const variants = {
    primary: "bg-primary-50 text-primary-700 border-primary-200",
    success: "bg-success-50 text-success-600 border-success-200",
    warning: "bg-warning-50 text-warning-600 border-warning-200",
    danger: "bg-error-50 text-error-600 border-error-200",
    neutral: "bg-slate-50 text-slate-600 border-slate-200",
  };

  return (
    <span
      className={twMerge(clsx(baseStyles, variants[variant], className))}
      {...props}
    >
      {children}
    </span>
  );
};
