import { Loader2 } from "lucide-react";
import { twMerge } from "tailwind-merge";

export const LoadingSpinner = ({ className, size = 24 }) => {
  return (
    <div className="flex items-center justify-center p-4">
      <Loader2
        className={twMerge("animate-spin text-primary-600", className)}
        size={size}
      />
    </div>
  );
};
