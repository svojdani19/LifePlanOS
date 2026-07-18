import { Badge, type BadgeTone } from "@/components/ui/Badge";

// Shared page header — one consistent scale for every top-level page:
// title, optional subtitle, optional status badge, optional inline metrics,
// and action slots. Server-component friendly (no state).
export function PageHeader({
  title,
  subtitle,
  status,
  metrics,
  actions,
}: {
  title: string;
  subtitle?: React.ReactNode;
  status?: { label: string; tone: BadgeTone };
  metrics?: { label: string; value: string }[];
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="h-page">{title}</h1>
          {status && <Badge tone={status.tone}>{status.label}</Badge>}
        </div>
        {subtitle && <p className="mt-1 text-sm text-ink-600">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-4">
        {metrics && metrics.length > 0 && (
          <dl className="hidden items-center gap-5 sm:flex">
            {metrics.map((m) => (
              <div key={m.label} className="text-right">
                <dd className="num-metric text-sm">{m.value}</dd>
                <dt className="text-meta">{m.label}</dt>
              </div>
            ))}
          </dl>
        )}
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
