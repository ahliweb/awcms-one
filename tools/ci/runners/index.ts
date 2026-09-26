/** runners/index.ts — dispatch a leg's `LegDefinition` to the runner that executes it. */
import type { LegDefinition } from "../legs.ts";
import type { LegContext, LegOutcome } from "../lib/types.ts";
import { runCheckLeg } from "./check.ts";
import { runCheckCmsLeg } from "./check-cms.ts";
import { runE2eLeg } from "./e2e.ts";
import { runSecurityLeg } from "./security.ts";
import { runTemplateLeg, runTemplateRootLeg } from "./template.ts";

export async function runLeg(leg: LegDefinition, ctx: LegContext): Promise<LegOutcome> {
  switch (leg.group) {
    case "check":
      return leg.profile
        ? runCheckLeg(leg.context, leg.profile, ctx)
        : runCheckCmsLeg(leg.context, ctx);
    case "template":
      return leg.profile
        ? runTemplateLeg(leg.context, leg.profile, ctx)
        : runTemplateRootLeg(leg.context, ctx);
    case "e2e":
      if (!leg.profile) throw new Error(`e2e leg ${leg.context} has no profile`);
      return runE2eLeg(leg.context, leg.profile, ctx);
    case "security":
      return runSecurityLeg(leg.context, ctx);
    default:
      throw new Error(`Unknown leg group for ${leg.context}`);
  }
}
