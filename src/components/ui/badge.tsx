import * as React from "react";
import { cn } from "@/lib/utils";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "secondary" | "success" | "warning" | "danger" | "outline";
}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = "default", ...props }, ref) => {
    const variants: Record<string, string> = {
      default: "bg-[var(--accent-900)] text-[var(--accent-300)] border-[var(--accent-800)]",
      secondary: "bg-[var(--surface-2)] text-[var(--text-secondary)] border-[var(--border-strong)]",
      success: "bg-[var(--success-muted)]/30 text-[var(--success)] border-[var(--success)]/20",
      warning: "bg-[var(--warning-muted)]/30 text-[var(--warning)] border-[var(--warning)]/20",
      danger: "bg-[var(--danger-muted)]/30 text-[var(--danger)] border-[var(--danger)]/20",
      outline: "bg-transparent text-[var(--text-secondary)] border-[var(--border-strong)]",
    };

    return (
      <span
        ref={ref}
        className={cn(
          "inline-flex items-center gap-1 rounded-[var(--radius-full)] border px-2 py-0.5 text-xs font-medium transition-colors",
          variants[variant],
          className
        )}
        {...props}
      />
    );
  }
);
Badge.displayName = "Badge";

export { Badge };
