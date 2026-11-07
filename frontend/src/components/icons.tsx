import type { ReactNode } from "react";
import type { StatusTone } from "../lib/semantic";

type IconProps = { className?: string };

function baseClass(className?: string): string {
  return className ?? "h-5 w-5";
}

/**
 * Every glyph is the same 24-unit, round-capped `currentColor` stroke drawing
 * with `aria-hidden="true"`: an icon never carries meaning on its own, so the
 * name must come from adjacent text or an `aria-label`. Icons differ only in
 * their paths, so they share this wrapper rather than repeating the list.
 */
function Glyph({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={baseClass(className)}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconDashboard({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </Glyph>
  );
}

export function IconInventory({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </Glyph>
  );
}

export function IconSources({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01" />
      <path d="M7 16.5h.01" />
    </Glyph>
  );
}

export function IconScan({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8" />
      <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
      <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
      <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <path d="M4 12h16" />
    </Glyph>
  );
}

export function IconRisk({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M12 3l7 3v6c0 4.4-2.9 7.6-7 9-4.1-1.4-7-4.6-7-9V6l7-3z" />
      <path d="M12 9v4" />
      <path d="M12 16.5h.01" />
    </Glyph>
  );
}

export function IconRetention({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Glyph>
  );
}

export function IconArchive({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 001 1h12a1 1 0 001-1V8" />
      <path d="M10 12h4" />
    </Glyph>
  );
}

export function IconRetrieval({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </Glyph>
  );
}

export function IconReports({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </Glyph>
  );
}

export function IconClassification({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M4 5h9l7 7-9 9-7-7V5z" />
      <circle cx="8.5" cy="9.5" r="1.5" />
    </Glyph>
  );
}

export function IconUsers({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
      <path d="M17 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
      <path d="M17.5 14.2c2.4.4 4 2.3 4 5.8" />
    </Glyph>
  );
}

/** A hold freezes lifecycle work, so it reads as a padlock rather than a clock. */
export function IconHold({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
      <path d="M8 10.5V8a4 4 0 018 0v2.5" />
      <path d="M12 14v2.5" />
    </Glyph>
  );
}

/** An advisory review queue is a checklist, not another warning sign. */
export function IconReview({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M4 7.5l1.6 1.6L8.4 6.2" />
      <path d="M11 8h9" />
      <path d="M4 14.5l1.6 1.6L8.4 13.2" />
      <path d="M11 15h9" />
    </Glyph>
  );
}

export function IconLogout({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3" />
      <path d="M10 8l-4 4 4 4" />
      <path d="M6 12h9" />
    </Glyph>
  );
}

export function IconMenu({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </Glyph>
  );
}

export function IconClose({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </Glyph>
  );
}

export function IconRefresh({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M20.5 12a8.5 8.5 0 11-2.6-6.1" />
      <path d="M21 4v5h-5" />
    </Glyph>
  );
}

export function IconSearch({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </Glyph>
  );
}

export function IconChevronDown({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M6 9l6 6 6-6" />
    </Glyph>
  );
}

export function IconChevronUp({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M6 15l6-6 6 6" />
    </Glyph>
  );
}

export function IconChevronLeft({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M15 6l-6 6 6 6" />
    </Glyph>
  );
}

export function IconChevronRight({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M9 6l6 6-6 6" />
    </Glyph>
  );
}

export function IconArrowLeft({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M19 12H5" />
      <path d="M11 6l-6 6 6 6" />
    </Glyph>
  );
}

export function IconPlus({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Glyph>
  );
}

export function IconFilter({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M4 6h16" />
      <path d="M7 12h10" />
      <path d="M10 18h4" />
    </Glyph>
  );
}

export function IconCircle({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="12" r="8" />
    </Glyph>
  );
}

export function IconCheck({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M5 13l4 4 10-10" />
    </Glyph>
  );
}

export function IconCheckCircle({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="12" r="8" />
      <path d="M8.5 12.2l2.3 2.3 4.7-4.8" />
    </Glyph>
  );
}

export function IconInfoCircle({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </Glyph>
  );
}

export function IconAlertTriangle({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M12 4.5l8 14h-16l8-14z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </Glyph>
  );
}

export function IconXCircle({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="12" r="8" />
      <path d="M9.5 9.5l5 5" />
      <path d="M14.5 9.5l-5 5" />
    </Glyph>
  );
}

/**
 * The status half of `lib/semantic`: a tone names a colour role and, here, its
 * glyph, so a component can never pair a warning colour with a success mark.
 * `accent` is not a status and deliberately has no glyph.
 */
const STATUS_GLYPHS: Record<StatusTone, (props: IconProps) => ReactNode> = {
  neutral: IconCircle,
  info: IconInfoCircle,
  success: IconCheckCircle,
  warning: IconAlertTriangle,
  caution: IconAlertTriangle,
  critical: IconXCircle,
};

export function StatusIcon({ tone, className }: { tone: StatusTone; className?: string }) {
  const GlyphIcon = STATUS_GLYPHS[tone];
  return <GlyphIcon className={className} />;
}
