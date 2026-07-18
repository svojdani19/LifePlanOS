import { cn } from "@/lib/utils";

// Semantic status tones (design-system contract):
//   success = approved / resolved / complete        (green)
//   warning = requires attention / moderate concern (amber)
//   danger  = blocking / high risk / rejected       (red)
//   info    = informational                         (blue)
//   ai      = AI-generated / machine-derived        (purple)
//   brand   = selected / primary highlight — use sparingly (teal)
//   neutral = inactive / metadata                   (gray)
// Legacy keys (green/amber/red/slate) remain as aliases so existing call
// sites keep working; new code should prefer the semantic names.
const tones = {
  neutral: "bg-ink-100 text-ink-700",
  brand: "bg-brand-100 text-brand-800",
  success: "bg-emerald-100 text-emerald-800",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-800",
  info: "bg-sky-100 text-sky-800",
  ai: "bg-violet-100 text-violet-800",
  // legacy aliases
  green: "bg-emerald-100 text-emerald-800",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
  slate: "bg-ink-800 text-white",
} as const;

export type BadgeTone = keyof typeof tones;

export function Badge({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
