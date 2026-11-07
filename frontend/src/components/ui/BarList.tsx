import { resolveTone, type ToneInput } from "../../lib/semantic";
import { TONE_SOLID } from "./statusClasses";

export interface BarItem {
  label: string;
  value: number;
  tone?: ToneInput;
}

/**
 * Dependency-free horizontal bar list — keeps the bundle small while giving
 * the dashboard readable distribution charts. `tone` takes a semantic role; the
 * legacy palette names are resolved onto a role by `resolveTone`.
 */
export function BarList({ items, unit = "" }: { items: BarItem[]; unit?: string }) {
  const max = items.reduce((highest, item) => Math.max(highest, item.value), 0);

  return (
    <ul className="space-y-3">
      {items.map((item) => {
        const width = max === 0 ? 0 : Math.max((item.value / max) * 100, item.value > 0 ? 4 : 0);
        return (
          <li key={item.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-body text-ink-muted">{item.label}</span>
              <span className="text-data font-medium text-ink tabular-nums">
                {item.value}
                {unit}
              </span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-pill bg-surface-sunken">
              <div
                className={`h-full rounded-pill ${TONE_SOLID[resolveTone(item.tone ?? "accent")]}`}
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
