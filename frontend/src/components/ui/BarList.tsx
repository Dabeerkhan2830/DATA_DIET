import type { Tone } from "../../lib/labels";

export interface BarItem {
  label: string;
  value: number;
  tone?: Tone;
}

const TONE_FILL: Record<Tone, string> = {
  slate: "bg-slate-400",
  indigo: "bg-indigo-500",
  emerald: "bg-emerald-500",
  sky: "bg-sky-500",
  amber: "bg-amber-500",
  orange: "bg-orange-500",
  rose: "bg-rose-500",
};

/**
 * Dependency-free horizontal bar list — keeps the bundle small while giving
 * the dashboard readable distribution charts.
 */
export function BarList({ items, unit = "" }: { items: BarItem[]; unit?: string }) {
  const max = items.reduce((highest, item) => Math.max(highest, item.value), 0);

  return (
    <ul className="space-y-3">
      {items.map((item) => {
        const width = max === 0 ? 0 : Math.max((item.value / max) * 100, item.value > 0 ? 4 : 0);
        return (
          <li key={item.label}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-slate-600">{item.label}</span>
              <span className="font-medium text-slate-900 tabular-nums">
                {item.value}
                {unit}
              </span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full ${TONE_FILL[item.tone ?? "indigo"]}`}
                style={{ width: `${width}%` }}
                role="presentation"
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
