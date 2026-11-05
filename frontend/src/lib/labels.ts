/** Maps domain values to display tones (see components/ui/Badge.tsx). */

import type { PolicyStatus, RetentionAction, RiskBand, Sensitivity } from "../api/types";

export type Tone = "slate" | "indigo" | "emerald" | "sky" | "amber" | "orange" | "rose";

export function toneForSensitivity(sensitivity: Sensitivity): Tone {
  switch (sensitivity) {
    case "restricted":
      return "rose";
    case "confidential":
      return "amber";
    case "internal":
      return "sky";
    case "public":
      return "emerald";
  }
}

export function toneForRiskBand(band: RiskBand): Tone {
  switch (band) {
    case "critical":
      return "rose";
    case "high":
      return "orange";
    case "moderate":
      return "amber";
    case "low":
      return "emerald";
  }
}

export function toneForRetentionAction(action: RetentionAction): Tone {
  switch (action) {
    case "eligible_for_disposal":
      return "rose";
    case "review":
      return "amber";
    case "archive":
      return "indigo";
    case "retain":
      return "emerald";
  }
}

export function toneForPolicyStatus(status: PolicyStatus): Tone {
  switch (status) {
    case "active":
      return "emerald";
    case "draft":
      return "amber";
    case "retired":
      return "slate";
  }
}
