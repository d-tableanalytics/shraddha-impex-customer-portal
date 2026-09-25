import { AlertTriangle, RefreshCw, Lock, Wrench } from "lucide-react";
import { twMerge } from "tailwind-merge";

import { Button } from "../ui/Button";

/**
 * Something went wrong, said usefully.
 *
 * The portal had EmptyState and LoadingSpinner but nothing for failure, so a
 * failed request rendered as "no records" - which reads as an answer rather
 * than a problem. The reference uses Alert and Result for this; this is the
 * Tailwind equivalent.
 *
 * Three variants because they mean genuinely different things to a user:
 *   error         something broke; retrying may help
 *   forbidden     you are not allowed here; retrying will not help
 *   unavailable   this is not built yet; nothing is wrong (AD-11's 503)
 */
const VARIANTS = {
  error: {
    icon: AlertTriangle,
    tone: "text-error-600 bg-error-50 border-error-100",
    title: "Something went wrong",
  },
  forbidden: {
    icon: Lock,
    tone: "text-warning-600 bg-warning-50 border-warning-100",
    title: "You do not have access",
  },
  unavailable: {
    icon: Wrench,
    tone: "text-slate-500 bg-slate-50 border-slate-200",
    title: "Not available yet",
  },
};

export const ErrorState = ({
  variant = "error",
  title,
  description,
  onRetry,
  retryLabel = "Try again",
  className,
}) => {
  const config = VARIANTS[variant] ?? VARIANTS.error;
  const Icon = config.icon;

  return (
    <div
      role="alert"
      className={twMerge(
        "flex flex-col items-center justify-center p-10 text-center bg-white border border-dashed border-slate-200 rounded-xl",
        className,
      )}
    >
      <div
        className={twMerge(
          "flex items-center justify-center w-16 h-16 mb-4 rounded-full border",
          config.tone,
        )}
      >
        <Icon className="w-7 h-7 stroke-[1.5]" />
      </div>
      <h3 className="text-sm font-semibold text-slate-900 mb-1">{title ?? config.title}</h3>
      {description && (
        <p className="text-xs text-slate-500 max-w-sm leading-relaxed">{description}</p>
      )}
      {/* Retrying a 403 or a 503 would just fail the same way, so the action is
          only offered where it can actually help. */}
      {onRetry && variant === "error" && (
        <Button variant="secondary" className="mt-5" onClick={onRetry}>
          <RefreshCw size={14} className="mr-1.5" />
          {retryLabel}
        </Button>
      )}
    </div>
  );
};

export default ErrorState;
