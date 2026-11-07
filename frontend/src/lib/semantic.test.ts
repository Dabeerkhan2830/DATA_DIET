import { describe, expect, it } from "vitest";
import {
  resolveStatusTone,
  resolveTone,
  toneForConfidence,
  toneForDecision,
  toneForHoldStatus,
  toneForLifecycleStatus,
  toneForPolicyStatus,
  toneForRecommendation,
  toneForReviewStatus,
  toneForSensitivity,
  toneForSeverity,
  type StatusTone,
  type Tone,
  type ToneInput,
} from "./semantic";

const STATUS_ROLES: StatusTone[] = ["neutral", "info", "success", "warning", "caution", "critical"];

const LEGACY_ALIASES: Array<[ToneInput, Tone]> = [
  ["slate", "neutral"],
  ["sky", "info"],
  ["emerald", "success"],
  ["amber", "warning"],
  ["orange", "caution"],
  ["rose", "critical"],
  ["indigo", "accent"],
];

describe("tone resolution", () => {
  it("passes a semantic role through unchanged", () => {
    for (const role of STATUS_ROLES) {
      expect(resolveTone(role)).toBe(role);
    }
    expect(resolveTone("accent")).toBe("accent");
  });

  it("folds every legacy palette name onto one role", () => {
    for (const [legacy, role] of LEGACY_ALIASES) {
      expect(resolveTone(legacy)).toBe(role);
    }
  });

  it("never lets a status surface report the brand colour as a state", () => {
    for (const role of STATUS_ROLES) {
      expect(resolveStatusTone(role)).toBe(role);
    }
    expect(resolveStatusTone("accent")).toBe("neutral");
    expect(resolveStatusTone("indigo")).toBe("neutral");
  });
});

describe("domain tables", () => {
  it("keeps the two severities that mean different things apart", () => {
    expect(toneForSeverity("high")).toBe("caution");
    expect(toneForSeverity("blocked")).toBe("critical");
    expect(toneForSeverity("medium")).toBe("warning");
    expect(toneForSeverity("low")).toBe("info");
  });

  it("reads a draft policy as a call to action, not as inert slate", () => {
    expect(toneForPolicyStatus("draft")).toBe("warning");
    expect(toneForPolicyStatus("retired")).toBe("neutral");
    expect(toneForPolicyStatus("active")).toBe("success");
  });

  it("maps every recommendation state the backend can return", () => {
    const states = [
      "RETAIN",
      "ARCHIVE_RECOMMENDED",
      "REVIEW_REQUIRED",
      "DISPOSAL_REVIEW_REQUIRED",
      "BLOCKED_BY_HOLD",
      "NO_APPLICABLE_POLICY",
    ] as const;

    for (const state of states) {
      const role = toneForRecommendation(state);
      expect([...STATUS_ROLES, "accent"] as Tone[]).toContain(role);
    }
    expect(toneForRecommendation("BLOCKED_BY_HOLD")).toBe("critical");
  });

  it("agrees with itself across the remaining helpers", () => {
    expect(toneForHoldStatus("active")).toBe("critical");
    expect(toneForHoldStatus("released")).toBe("neutral");
    expect(toneForDecision("reject")).toBe("critical");
    expect(toneForDecision("retain")).toBe("success");
    expect(toneForConfidence("none")).toBe("neutral");
    expect(toneForReviewStatus("open")).toBe("warning");
    expect(toneForReviewStatus("decided")).toBe("success");
  });

  it("reads an unclassified asset as neither safe nor dangerous", () => {
    expect(toneForSensitivity("restricted")).toBe("critical");
    expect(toneForSensitivity("confidential")).toBe("warning");
    expect(toneForSensitivity("internal")).toBe("info");
    expect(toneForSensitivity("public")).toBe("success");
    expect(toneForSensitivity("unknown")).toBe("neutral");
  });

  it("maps every lifecycle status the asset schema can hold", () => {
    expect(toneForLifecycleStatus("active")).toBe("success");
    expect(toneForLifecycleStatus("under_review")).toBe("warning");
    expect(toneForLifecycleStatus("archived")).toBe("neutral");
    // Awaiting disposal is the state a human must look at, so it is not neutral.
    expect(toneForLifecycleStatus("pending_disposal")).toBe("critical");
  });
});
