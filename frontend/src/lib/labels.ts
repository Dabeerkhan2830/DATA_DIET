/**
 * Compatibility shim for the pre-token tone helpers.
 *
 * The mapping itself now lives in `lib/semantic.ts`, which owns both the
 * semantic colour roles and the domain tables; this module only keeps the old
 * import path and export names resolving for existing call sites.
 *
 * @deprecated Import from `lib/semantic` instead.
 */

import type { ToneInput } from "./semantic";

/**
 * The union `lib/labels` originally exported — the palette names — widened to
 * also accept the semantic roles the helpers now return, so code written
 * against the old type keeps compiling.
 */
export type Tone = ToneInput;

export {
  toneForPolicyStatus,
  toneForRetentionAction,
  toneForRiskBand,
  toneForSensitivity,
} from "./semantic";
