/**
 * The single source of truth for how a domain value is *displayed*: its semantic
 * colour role and its readable label. Call sites pick a role through one of the
 * `toneFor*` helpers, never a colour directly.
 *
 * Before this module, the same values were mapped in seven places —
 * `lib/labels.ts` plus five page-local tables — and two of them disagreed:
 * policy `draft` was amber in one and slate in the other, quality severity
 * `high` was rose in one and orange in the other. The tables now live here and
 * resolve those conflicts; `lib/labels.ts` survives only as a re-export shim.
 */

import type {
  AssetSensitivity,
  ClassificationConfidence,
  DecisionValue,
  FindingSeverity,
  HoldStatus,
  LifecycleStatus,
  PolicyStatus,
  PolicyVersionStatus,
  Phase3PolicyStatus,
  QualitySeverity,
  RecommendationState,
  RetentionAction,
  ReviewStatus,
  RiskBand,
  ScanStatus,
  SourceStatus,
} from "../api/types";
import { humanize } from "./format";

/** Semantic colour roles, each defined as a token quartet in `index.css`. */
export type Tone = "neutral" | "info" | "success" | "warning" | "caution" | "critical" | "accent";

/**
 * The roles that describe a *state* rather than a brand highlight. Feedback
 * surfaces — toasts, inline messages, progress — accept only these, because
 * `accent` has no status glyph in `components/icons.tsx` and must not be
 * presented as one.
 */
export type StatusTone = Exclude<Tone, "accent">;

/**
 * The palette names `Badge` and `BarList` accepted before the tokens existed.
 * They are still accepted so existing call sites keep compiling, but no feature
 * page should add one: `resolveTone` folds it onto a role immediately.
 */
export type PaletteTone = "slate" | "sky" | "emerald" | "amber" | "orange" | "rose" | "indigo";

/** Anything `Badge`/`BarList` accept as a tone — a role, or a legacy alias. */
export type ToneInput = Tone | PaletteTone;

const PALETTE_ALIASES: Record<PaletteTone, Tone> = {
  slate: "neutral",
  sky: "info",
  emerald: "success",
  amber: "warning",
  orange: "caution",
  rose: "critical",
  indigo: "accent",
};

/** Collapse a legacy palette name onto its semantic role. */
export function resolveTone(tone: ToneInput): Tone {
  return tone in PALETTE_ALIASES ? PALETTE_ALIASES[tone as PaletteTone] : (tone as Tone);
}

/**
 * The same collapse for feedback surfaces (toast, progress, inline message),
 * which may only show a state: a call site that passes `accent` — or a legacy
 * `indigo` — means "no status", so it resolves to `neutral` instead of
 * inventing a sixth meaning for the brand colour.
 */
export function resolveStatusTone(tone: ToneInput): StatusTone {
  const role = resolveTone(tone);
  return role === "accent" ? "neutral" : role;
}

const SENSITIVITY_TONES: Record<AssetSensitivity, Tone> = {
  restricted: "critical",
  confidential: "warning",
  internal: "info",
  public: "success",
  /** An unclassified asset is not a safe asset, but it is not a danger either. */
  unknown: "neutral",
};

const RISK_BAND_TONES: Record<RiskBand, Tone> = {
  critical: "critical",
  high: "caution",
  moderate: "warning",
  low: "success",
};

const RETENTION_ACTION_TONES: Record<RetentionAction, Tone> = {
  eligible_for_disposal: "critical",
  review: "warning",
  archive: "accent",
  retain: "success",
};

/** `draft` is a call to action, so it reads as warning rather than inert slate. */
const POLICY_STATUS_TONES: Record<PolicyStatus | PolicyVersionStatus | Phase3PolicyStatus, Tone> = {
  active: "success",
  draft: "warning",
  retired: "neutral",
  approved: "info",
  inactive: "neutral",
};

/** `high` is caution (orange), not critical (rose): only `blocked` stops work. */
const SEVERITY_TONES: Record<FindingSeverity | QualitySeverity, Tone> = {
  informational: "neutral",
  info: "neutral",
  low: "info",
  medium: "warning",
  high: "caution",
  blocked: "critical",
};

const RECOMMENDATION_TONES: Record<RecommendationState, Tone> = {
  RETAIN: "success",
  ARCHIVE_RECOMMENDED: "info",
  REVIEW_REQUIRED: "warning",
  DISPOSAL_REVIEW_REQUIRED: "caution",
  BLOCKED_BY_HOLD: "critical",
  NO_APPLICABLE_POLICY: "neutral",
};

const HOLD_STATUS_TONES: Record<HoldStatus, Tone> = {
  active: "critical",
  released: "neutral",
};

const DECISION_TONES: Record<DecisionValue, Tone> = {
  retain: "success",
  request_more_information: "warning",
  approve_for_later_workflow: "info",
  reject: "critical",
};

const CONFIDENCE_TONES: Record<ClassificationConfidence, Tone> = {
  high: "success",
  medium: "info",
  low: "warning",
  none: "neutral",
};

const REVIEW_STATUS_TONES: Record<ReviewStatus, Tone> = {
  open: "warning",
  decided: "success",
};

export function toneForSensitivity(value: AssetSensitivity): Tone {
  return SENSITIVITY_TONES[value];
}

/**
 * The lifecycle state of an asset as the inventory stores it. `pending_disposal`
 * is critical for the same reason `eligible_for_disposal` is: it is the state a
 * human must look at, not a settled one. Nothing in this table executes a
 * lifecycle action.
 */
const LIFECYCLE_STATUS_TONES: Record<LifecycleStatus, Tone> = {
  active: "success",
  under_review: "warning",
  archived: "neutral",
  pending_disposal: "critical",
};

export function toneForLifecycleStatus(value: LifecycleStatus): Tone {
  return LIFECYCLE_STATUS_TONES[value];
}

export function toneForRiskBand(value: RiskBand): Tone {
  return RISK_BAND_TONES[value];
}

export function toneForRetentionAction(value: RetentionAction): Tone {
  return RETENTION_ACTION_TONES[value];
}

export function toneForPolicyStatus(value: PolicyStatus | PolicyVersionStatus | Phase3PolicyStatus): Tone {
  return POLICY_STATUS_TONES[value];
}

export function toneForSeverity(value: FindingSeverity | QualitySeverity): Tone {
  return SEVERITY_TONES[value];
}

export function toneForRecommendation(value: RecommendationState): Tone {
  return RECOMMENDATION_TONES[value];
}

export function toneForHoldStatus(value: HoldStatus): Tone {
  return HOLD_STATUS_TONES[value];
}

export function toneForDecision(value: DecisionValue): Tone {
  return DECISION_TONES[value];
}

export function toneForConfidence(value: ClassificationConfidence): Tone {
  return CONFIDENCE_TONES[value];
}

export function toneForReviewStatus(value: ReviewStatus): Tone {
  return REVIEW_STATUS_TONES[value];
}

/**
 * Whether an operator has enabled a source. `active` is `info`, deliberately not
 * `success`: the backend sets it at creation without touching the source
 * (`connectors.py` forces `status="active"`), so it records intent, not a
 * verified connection. The green that means "checked and reachable" is
 * `last_validation_ok === true`, which a screen reads separately.
 */
const SOURCE_STATUS_TONES: Record<SourceStatus, Tone> = {
  active: "info",
  inactive: "neutral",
};

/**
 * The six scan states as the service stores them. `PENDING` is a call to action
 * — it can still be run or cancelled — so it reads as warning, not as a settled
 * neutral. `COMPLETED_WITH_ERRORS` is caution, not critical: the scan imported
 * something, and the errors are per-record rows to look at.
 */
const SCAN_STATUS_TONES: Record<ScanStatus, Tone> = {
  PENDING: "warning",
  RUNNING: "info",
  COMPLETED: "success",
  COMPLETED_WITH_ERRORS: "caution",
  FAILED: "critical",
  CANCELLED: "neutral",
};

export function toneForSourceStatus(value: SourceStatus): Tone {
  return SOURCE_STATUS_TONES[value];
}

export function toneForScanStatus(value: ScanStatus): Tone {
  return SCAN_STATUS_TONES[value];
}

/**
 * One discovered record's outcome. `ScanResultRead.status` is a free string in
 * the schema, so an unrecognised value falls back to `neutral` rather than being
 * dressed up as one of the three the scan service writes.
 */
export function toneForScanOutcome(value: string): Tone {
  if (value === "imported") {
    return "success";
  }
  if (value === "skipped") {
    return "neutral";
  }
  return value === "error" ? "critical" : "neutral";
}

/** A scan error row's severity: `warning` is a truncation notice, not a failure. */
export function toneForScanSeverity(value: string): Tone {
  return value === "warning" ? "caution" : "critical";
}

/**
 * The label helper for new code. The domain spells lowercase values as machine
 * tokens (`request_more_information`) and recommendation states in SCREAMING
 * snake case (`DISPOSAL_REVIEW_REQUIRED`), so one rule covers both: expand the
 * separators, and re-case only a value that was written in capitals — a
 * lowercase value keeps its casing, because that is how the backend spells it.
 *
 * The existing pages still render their baseline `replaceAll("_", " ")` wording.
 * Phase 1 changes the design system, not the copy, so switching those call
 * sites over is a separate, approved decision.
 */
export function statusLabel(value: string): string {
  if (/^[A-Z0-9_]+$/.test(value)) {
    return humanize(value.toLowerCase());
  }
  return value.replace(/[_-]+/g, " ").trim();
}
