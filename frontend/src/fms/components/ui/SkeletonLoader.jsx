import { twMerge } from "tailwind-merge";

export const SkeletonLoader = ({
  className,
  variant = "rectangular",
  ...props
}) => {
  return (
    <div
      className={twMerge(
        "animate-pulse bg-slate-200",
        variant === "text" && "h-4 w-full rounded",
        variant === "rectangular" && "h-24 w-full rounded-lg",
        variant === "circular" && "h-12 w-12 rounded-full",
        className,
      )}
      {...props}
    />
  );
};
export default SkeletonLoader;
