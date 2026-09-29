/**
 * The five canonical IRM domains (Issue #270, ADR-0002 in `web-irmbydus.com`) —
 * IDENTIFY / NEUTRALIZE / NAVIGATE / EMBED / REINFORCE. Pure domain types and
 * the built-in fallback copy only — no database, no I/O.
 *
 * ## Why this exists at all: preventing terminology drift
 *
 * PRD's Major Risks table names "IRM terminology drift" as a High-impact risk,
 * mitigated by "source-authoritative content review". ADR-0002's Consequences
 * say it plainly: "IRM content edits happen once, in the CMS admin, not in
 * frontend code." `web-irmbydus.com` renders whatever this module's read API
 * returns; it holds no independent copy of a domain's name, description, or
 * copy. A wording fix therefore ships as one CMS admin edit, never a frontend
 * deploy — which is the whole point of making this CMS-editable content
 * instead of a hardcoded string table on the storefront.
 *
 * ## `DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT` is a FALLBACK, not the source of truth
 *
 * A brand-new tenant that has never opened the admin screen still has to
 * answer "what is IDENTIFY" the first time a customer reads it — so the five
 * built-in entries below exist purely so the read path never returns an empty
 * domain. The moment an admin edits one (`application/practice-irm-domain-
 * directory.ts`'s `upsertPracticeIrmDomain`), the DATABASE row is authoritative
 * for that domain from then on; this constant is consulted only for a
 * domain_key with no live row (see that file's `mergeWithDefaults`).
 */

export const PRACTICE_IRM_DOMAIN_KEYS = [
  "identify",
  "neutralize",
  "navigate",
  "embed",
  "reinforce"
] as const;

export type PracticeIrmDomainKey = (typeof PRACTICE_IRM_DOMAIN_KEYS)[number];

export function isPracticeIrmDomainKey(
  value: unknown
): value is PracticeIrmDomainKey {
  return (
    typeof value === "string" &&
    (PRACTICE_IRM_DOMAIN_KEYS as readonly string[]).includes(value)
  );
}

/** The shape every read path (admin CRUD, the customer-facing content read) returns. */
export type PracticeIrmDomainContent = {
  id: string;
  domainKey: PracticeIrmDomainKey;
  name: string;
  description: string;
  copy: string;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * Built-in English copy, used only where no tenant-authored row exists yet
 * (see this file's own header). Deliberately plain and short — a
 * placeholder an admin is expected to replace with the source-authoritative
 * wording, never a claim of clinical accuracy on its own.
 */
export const DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT: Readonly<
  Record<
    PracticeIrmDomainKey,
    { name: string; description: string; copy: string; displayOrder: number }
  >
> = {
  identify: {
    name: "Identify",
    description:
      "Notice the situation, the emotion, and the automatic thought.",
    copy: "Pause and name what is happening: the situation, what you feel, how strong it feels, where it shows up in your body, and the thought that came with it.",
    displayOrder: 1
  },
  neutralize: {
    name: "Neutralize",
    description: "Work with the automatic thought rather than being run by it.",
    copy: "Look at the thought you named. What else could be true? What would you say to a friend who had this same thought?",
    displayOrder: 2
  },
  navigate: {
    name: "Navigate",
    description: "Choose a next step that fits the situation.",
    copy: "With the thought loosened, what is one concrete, manageable step you can take next?",
    displayOrder: 3
  },
  embed: {
    name: "Embed",
    description: "Practice the step until it becomes familiar.",
    copy: "Repeat the step in small, low-stakes moments so it becomes easier to reach for next time.",
    displayOrder: 4
  },
  reinforce: {
    name: "Reinforce",
    description: "Notice what changed and let that noticing stick.",
    copy: "Look back at what happened. What is different now, even a little? Write it down so it is easier to find again.",
    displayOrder: 5
  }
};
