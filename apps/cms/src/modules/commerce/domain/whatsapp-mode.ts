/**
 * The per-tenant WhatsApp delivery mode (Issue #392, ADR-0133 section 6 phase
 * 2). Pure: no database, no I/O.
 *
 * A tenant is in EXACTLY ONE mode at a time (ADR-0133 section 6 phase 3: two
 * live queues for one tenant is the "second WhatsApp queue" the ADR refuses):
 *
 *   * `legacy`   - `enqueueWhatsappMessage` writes
 *     `awcms_commerce_whatsapp_messages`, drained by `commerce:whatsapp:dispatch`.
 *     The default, and byte-for-byte what the function did before the mode
 *     existed.
 *   * `upstream` - it calls `WhatsappDeliveryPort.enqueue` in the caller's
 *     transaction and the message enters `awcms_whatsapp_messages`, drained by
 *     `whatsapp:dispatch`.
 *
 * The mode selects where NEW messages go. It never moves a row: in-flight legacy
 * rows are drained by the legacy dispatcher to a terminal state (issue #393 owns
 * the guarded flip that waits for that drain).
 */
export const WHATSAPP_MODES = ["legacy", "upstream"] as const;

export type WhatsappMode = (typeof WHATSAPP_MODES)[number];

export const DEFAULT_WHATSAPP_MODE: WhatsappMode = "legacy";

/**
 * Reads the stored column. Anything that is not exactly `upstream` is `legacy`:
 * a missing settings row, a null, or a value a future migration might add that
 * this code does not know must never route a message to the new queue by
 * accident (the `CHECK` constraint already refuses an unknown value; this is the
 * belt to that brace).
 */
export function parseWhatsappMode(raw: unknown): WhatsappMode {
  return raw === "upstream" ? "upstream" : DEFAULT_WHATSAPP_MODE;
}
