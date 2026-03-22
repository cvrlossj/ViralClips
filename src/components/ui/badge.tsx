import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default:
          "border-[var(--line-2)] bg-[var(--surface-2)] text-[var(--foreground)]",
        accent:
          "border-[var(--accent)]/40 bg-[var(--accent)]/15 text-[var(--accent-fg)]",
        success:
          "border-[var(--accent-2)]/40 bg-[var(--accent-2)]/15 text-[var(--accent-2-fg)]",
        outline:
          "border-[var(--line-2)] bg-transparent text-[var(--muted-fg)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
