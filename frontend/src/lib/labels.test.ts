import { describe, expect, it } from "vitest";
import {
  toneForPolicyStatus,
  toneForRetentionAction,
  toneForRiskBand,
  toneForSensitivity,
  type Tone,
} from "./labels";
import { resolveTone, statusLabel } from "./semantic";

describe("lib/labels compatibility surface", () => {
  it("still accepts the pre-token palette names as a Tone", () => {
    const legacy: Tone = "rose";
    expect(resolveTone(legacy)).toBe("critical");
  });

  it("also accepts the semantic roles the helpers now return", () => {
    const fromHelper: Tone = toneForSensitivity("restricted");
    expect(fromHelper).toBe("critical");
  });

  it("keeps every exported helper resolving to a semantic role", () => {
    expect(toneForSensitivity("restricted")).toBe("critical");
    expect(toneForRiskBand("high")).toBe("caution");
    expect(toneForRetentionAction("archive")).toBe("accent");
    expect(toneForPolicyStatus("draft")).toBe("warning");
  });
});

describe("statusLabel", () => {
  it("expands separators without re-casing a lowercase value", () => {
    expect(statusLabel("request_more_information")).toBe("request more information");
    expect(statusLabel("draft")).toBe("draft");
    expect(statusLabel("active")).toBe("active");
  });

  it("re-cases a SCREAMING_SNAKE value into readable words", () => {
    expect(statusLabel("DISPOSAL_REVIEW_REQUIRED")).toBe("Disposal review required");
    expect(statusLabel("RETAIN")).toBe("Retain");
  });

  it("differs from the label the pages render today only by the leading capital", () => {
    const value = "NO_APPLICABLE_POLICY";
    const renderedToday = value.replaceAll("_", " ");

    expect(statusLabel(value)).toBe(
      renderedToday.charAt(0) + renderedToday.slice(1).toLowerCase(),
    );
  });
});
