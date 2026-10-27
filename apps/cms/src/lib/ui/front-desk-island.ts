/**
 * The DOM half of the cashier / front-desk screen (Issue #388, UX flows section
 * 5). `CommerceFrontDesk.astro` renders the markup and every sentence (as
 * `data-*` on `#fd-root`); `front-desk-client.ts` holds the rules; this module
 * wires them to the page. It is loaded with a dynamic `import()` by
 * `commerce-pos.astro`, only when the front-desk tab rendered `#fd-root`, so the
 * other POS tabs download none of it.
 *
 * ## Memory only
 *
 * The reservation card, the masked contact and the identifier the cashier typed
 * (kept so the card can be re-read after a write) live in the closure below.
 * Nothing is written to `localStorage`, `sessionStorage` or IndexedDB. The
 * contact field is emptied the moment a card is found, and "Clear" drops the
 * rest. The one storage READ is the cashier's own shortcut remap, written by the
 * sale screen.
 *
 * ## Focus, after every outcome (WCAG 2.4.3)
 *
 * - invalid or refused lookup: the first refused field, `aria-invalid="true"` and
 *   tied to the message with `aria-describedby`;
 * - a card found: the card's heading, so a screen reader reads the reservation;
 * - a check-in, check-out or payment (or a refusal of one): the result line, a
 *   `role="status"` element that is also focused, because a region revealed
 *   together with its text is not reliably announced;
 * - an invalid tender: the line's amount field;
 * - "Clear": the code field.
 *
 * A control that cannot be used is `aria-disabled` rather than `disabled`, so a
 * keyboard user can still land on it and hear WHY (the reason is its
 * `aria-describedby`); activating it only says the reason again.
 */
import {
  actionForCombo,
  comboFromEvent,
  resolvePosShortcuts,
  type PosShortcutAction,
  type PosShortcutMap
} from "../../modules/commerce/domain/pos-shortcuts";
import { ScanBurstDetector } from "../../modules/commerce/domain/pos-scan";
import { sendJsonRequest } from "./admin-form-client";
import {
  actionStates,
  buildBalanceBody,
  buildLookupBody,
  createAttemptKeys,
  firstTenderProblem,
  formatMoney,
  fromCents,
  isFrontDeskCard,
  isOutcomeUnknown,
  isStoredValueTender,
  nightsBetween,
  outstandingFromDetails,
  planBalanceTenders,
  refusalKey,
  refusalReloadsCard,
  requestSignature,
  statusTone,
  tenderFieldTarget,
  toCents,
  validationFields,
  type BlockedReason,
  type FrontDeskCard,
  type LookupBody,
  type TenderLine,
  type TenderType
} from "./front-desk-client";

/** The key the sale screen stores a cashier's own shortcut remap under (`pos-keyboard-client.ts`). */
const SHORTCUTS_STORAGE_KEY = "awcms-one:pos-shortcuts:v1";
const BASE = "/api/v1/commerce/pos/booking";

type TenderRow = {
  row: HTMLElement;
  type: HTMLSelectElement;
  amount: HTMLInputElement;
  reference: HTMLInputElement;
  referenceWrap: HTMLElement;
  code: HTMLInputElement;
  codeWrap: HTMLElement;
  remove: HTMLButtonElement;
  amountLabel: HTMLElement;
};

const BLOCKED_REASON_KEY: Record<BlockedReason, string> = {
  no_permission: "reasonNoPermission",
  no_session: "reasonNoSession",
  balance_not_settled: "reasonBalanceNotSettled",
  not_confirmed: "reasonNotConfirmed",
  not_checked_in: "reasonNotCheckedIn",
  nothing_owed: "reasonNothingOwed",
  not_payable: "reasonNotPayable"
};

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  return (
    target instanceof HTMLInputElement &&
    !["button", "submit", "reset", "checkbox", "radio", "range"].includes(
      target.type
    )
  );
}

function readUserShortcuts(): unknown {
  try {
    const raw = window.localStorage.getItem(SHORTCUTS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

export function initFrontDesk(root: HTMLElement): void {
  const ds = root.dataset;
  const msg = (key: string): string => ds[key] ?? "";
  const fill = (template: string, values: Record<string, string>): string =>
    template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");
  const byId = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as T;

  const intlTag = ds.intlTag || "en-GB";
  const currency = ds.currency || "IDR";
  const money = (value: string): string =>
    formatMoney(value, intlTag, currency);
  const registerMode = ds.registerMode === "true";
  const caps = {
    canCheckIn: ds.canCheckIn === "true",
    canCheckOut: ds.canCheckOut === "true",
    canCollect: ds.canCollect === "true"
  };
  let registerLabels: Record<string, string> = {};
  try {
    registerLabels = JSON.parse(ds.registerLabels ?? "{}") as Record<
      string,
      string
    >;
  } catch {
    registerLabels = {};
  }
  let statusLabels: Record<string, string> = {};
  try {
    statusLabels = JSON.parse(ds.statusLabels ?? "{}") as Record<
      string,
      string
    >;
  } catch {
    statusLabels = {};
  }

  const lookupForm = byId<HTMLFormElement>("fd-lookup-form");
  const codeInput = byId<HTMLInputElement>("fd-code");
  const contactInput = byId<HTMLInputElement>("fd-contact");
  const findButton = byId<HTMLButtonElement>("fd-find");
  const clearButton = byId<HTMLButtonElement>("fd-clear");
  const lookupError = byId<HTMLElement>("fd-lookup-error");
  const resultEl = byId<HTMLElement>("fd-result");
  const announceEl = byId<HTMLElement>("fd-announce");
  const cardEl = byId<HTMLElement>("fd-card");
  const cardHeading = byId<HTMLElement>("fd-card-heading");
  const checkInButton = byId<HTMLButtonElement>("fd-check-in");
  const checkOutButton = byId<HTMLButtonElement>("fd-check-out");
  const balanceForm = byId<HTMLFormElement>("fd-balance-form");
  const balanceError = byId<HTMLElement>("fd-balance-error");
  const collectButton = byId<HTMLButtonElement>("fd-collect");
  const tendersEl = byId<HTMLElement>("fd-tenders");
  const rowTemplate = byId<HTMLTemplateElement>("fd-tender-row-template");
  const registerEl = document.getElementById("fd-register") as
    HTMLInputElement | HTMLSelectElement | null;
  const dialog = document.getElementById(
    "fd-shortcuts-dialog"
  ) as HTMLDialogElement | null;

  // ---- memory-only state -------------------------------------------------
  let card: FrontDeskCard | null = null;
  /** What found the card, kept only so the card can be re-read after a write. */
  let identity: LookupBody | null = null;
  let busy = false;
  const rows: TenderRow[] = [];
  const checkInKeys = createAttemptKeys();
  const checkOutKeys = createAttemptKeys();
  const collectKeys = createAttemptKeys();

  const registerId = (): string => registerEl?.value ?? "";
  const hasSession = (): boolean => registerMode && registerId() !== "";

  /** "Recorded against your account on register X": what the audit row says, in words. */
  const recorded = (): string =>
    fill(msg("msgRecorded"), {
      register: registerLabels[registerId()] ?? registerId()
    });

  // ---- announcements -----------------------------------------------------
  function announce(text: string): void {
    announceEl.textContent = "";
    announceEl.textContent = text;
  }

  /**
   * A refusal reads as an alert (the shared error style, `role="alert"`); a
   * success or a note as a status (`state-notice`). The line takes focus either
   * way: a region revealed together with its text is not reliably announced.
   */
  function showResult(text: string, tone: "success" | "danger" | "info"): void {
    const refused = tone === "danger";
    resultEl.className = refused
      ? "admin-create-error fd-result"
      : "state-notice fd-result";
    resultEl.setAttribute("role", refused ? "alert" : "status");
    resultEl.textContent = text;
    resultEl.hidden = false;
    resultEl.focus();
  }
  function hideResult(): void {
    resultEl.hidden = true;
    resultEl.textContent = "";
  }

  // ---- invalid-field plumbing --------------------------------------------
  function markInvalid(
    input: HTMLElement,
    messageId: string,
    invalid: boolean
  ): void {
    const ids = (input.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    if (invalid) {
      input.setAttribute("aria-invalid", "true");
      if (!ids.includes(messageId)) ids.push(messageId);
    } else {
      input.removeAttribute("aria-invalid");
    }
    if (ids.length > 0) input.setAttribute("aria-describedby", ids.join(" "));
    else input.removeAttribute("aria-describedby");
  }
  function clearLookupError(): void {
    lookupError.hidden = true;
    lookupError.textContent = "";
    markInvalid(codeInput, "fd-lookup-error", false);
    markInvalid(contactInput, "fd-lookup-error", false);
  }
  /** Shows a lookup refusal; the fields it is about are marked invalid and the first takes focus (none: the message does). */
  function lookupFailed(text: string, fields: HTMLInputElement[]): void {
    clearLookupError();
    lookupError.textContent = text;
    lookupError.hidden = false;
    for (const field of fields) markInvalid(field, "fd-lookup-error", true);
    (fields[0] ?? lookupError).focus();
  }
  function clearBalanceError(): void {
    balanceError.hidden = true;
    balanceError.textContent = "";
    for (const line of rows) {
      markInvalid(line.amount, "fd-balance-error", false);
      markInvalid(line.code, "fd-balance-error", false);
    }
  }

  // ---- the card ----------------------------------------------------------
  function setReason(
    id: string,
    state: { reason: BlockedReason | null }
  ): void {
    byId(id).textContent = state.reason
      ? msg(BLOCKED_REASON_KEY[state.reason])
      : "";
  }
  function setEnabled(button: HTMLButtonElement, enabled: boolean): void {
    if (enabled) button.removeAttribute("aria-disabled");
    else button.setAttribute("aria-disabled", "true");
  }

  function render(next: FrontDeskCard): void {
    card = next;
    const nights = nightsBetween(next.startsAt, next.endsAt);
    const day = new Intl.DateTimeFormat(intlTag, {
      dateStyle: "medium",
      timeZone: "UTC"
    });
    const stayDate = (iso: string): string => {
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? "—" : day.format(date);
    };

    cardHeading.textContent = next.reservationNo;
    const pill = byId("fd-status");
    pill.dataset.tone = statusTone(next.status);
    byId("fd-status-text").textContent =
      statusLabels[next.status] ?? next.status;

    byId("fd-guest").textContent = next.guest.name;
    byId("fd-contact-masked").textContent = [
      next.guest.phoneMasked,
      next.guest.emailMasked
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    byId("fd-service").textContent = next.serviceLine
      ? `${next.serviceLine.name} × ${next.serviceLine.quantity}`
      : "—";
    byId("fd-stay").textContent =
      `${stayDate(next.startsAt)} → ${stayDate(next.endsAt)} · ${
        nights === 1
          ? msg("msgNightsOne")
          : fill(msg("msgNightsMany"), { count: String(nights) })
      }`;
    const orderLink = byId<HTMLAnchorElement>("fd-order-link");
    orderLink.textContent = next.orderCode;
    orderLink.href = `/admin/commerce-orders/${encodeURIComponent(next.orderId)}`;

    byId("fd-total").textContent = money(next.settlement.total);
    byId("fd-paid").textContent = money(next.settlement.paid);
    byId("fd-due").textContent = money(next.settlement.balanceDue);

    byId("fd-policy").textContent =
      toCents(next.settlement.balanceDue) > 0n && next.status === "confirmed"
        ? next.policy.checkInRequiresSettlement
          ? msg("msgPolicyBlocks")
          : msg("msgPolicyAllows")
        : "";

    refreshControls();
    cardEl.hidden = false;
    cardEl.setAttribute("aria-busy", "false");
  }

  /** Re-derives every control from the card, the permissions and the open session. */
  function refreshControls(): void {
    if (!card) return;
    const states = actionStates(card, { ...caps, hasSession: hasSession() });
    setEnabled(checkInButton, states.checkIn.enabled);
    setReason("fd-check-in-reason", states.checkIn);
    setEnabled(checkOutButton, states.checkOut.enabled);
    setReason("fd-check-out-reason", states.checkOut);

    const owed = toCents(card.settlement.balanceDue) > 0n;
    balanceForm.hidden = !owed;
    setEnabled(collectButton, states.collect.enabled);
    setReason("fd-collect-reason", states.collect);
    for (const line of rows) {
      line.type.disabled = !states.collect.enabled;
      line.amount.disabled = !states.collect.enabled;
      line.reference.disabled = !states.collect.enabled;
      line.code.disabled = !states.collect.enabled;
      line.remove.disabled = !states.collect.enabled;
    }
    byId<HTMLButtonElement>("fd-add-tender").disabled = !states.collect.enabled;
    recomputeSummary();
  }

  // ---- tender lines ------------------------------------------------------
  function lineValues(): TenderLine[] {
    return rows.map((line) => ({
      type: line.type.value as TenderType,
      amount: line.amount.value,
      reference: line.reference.value,
      code: line.code.value
    }));
  }

  function syncRows(): void {
    rows.forEach((line, index) => {
      const cash = line.type.value === "cash";
      const stored = isStoredValueTender(line.type.value as TenderType);
      line.row.setAttribute("aria-label", `${msg("labelTender")} ${index + 1}`);
      line.amountLabel.textContent = cash
        ? msg("labelAmountCash")
        : msg("labelAmount");
      line.referenceWrap.hidden = cash || stored;
      line.codeWrap.hidden = !stored;
      if (!stored) line.code.value = "";
      line.remove.textContent = msg("labelRemove");
      line.remove.setAttribute(
        "aria-label",
        `${msg("labelRemove")}: ${msg("labelTender")} ${index + 1}`
      );
      line.remove.hidden = rows.length <= 1;
    });
    recomputeSummary();
  }

  function addRow(type: TenderType, focus: boolean): void {
    const fragment = rowTemplate.content.cloneNode(true) as DocumentFragment;
    const row = fragment.querySelector<HTMLElement>(".fd-tender-row");
    if (!row) return;
    const q = <T extends HTMLElement>(name: string): T =>
      row.querySelector(`[data-field="${name}"]`) as T;
    q("type-label").textContent = msg("labelMethod");
    q("reference-label").textContent = msg("labelReference");
    q("code-label").textContent = msg("labelCode");
    const line: TenderRow = {
      row,
      type: q<HTMLSelectElement>("type"),
      amount: q<HTMLInputElement>("amount"),
      reference: q<HTMLInputElement>("reference"),
      referenceWrap: q("reference-wrap"),
      code: q<HTMLInputElement>("code"),
      codeWrap: q("code-wrap"),
      remove: q<HTMLButtonElement>("remove"),
      amountLabel: q("amount-label")
    };
    line.type.value = type;
    line.type.addEventListener("change", syncRows);
    line.amount.addEventListener("input", () => {
      markInvalid(line.amount, "fd-balance-error", false);
      recomputeSummary();
    });
    line.remove.addEventListener("click", () => {
      const index = rows.indexOf(line);
      if (index >= 0) rows.splice(index, 1);
      line.row.remove();
      syncRows();
      // The removed line took focus with it: land on the line before it.
      (rows[Math.max(0, index - 1)]?.amount ?? byId("fd-add-tender")).focus();
    });
    rows.push(line);
    tendersEl.appendChild(fragment);
    syncRows();
    if (focus) line.amount.focus();
  }

  function resetRows(): void {
    rows.length = 0;
    tendersEl.textContent = "";
    addRow("cash", false);
  }

  function recomputeSummary(): void {
    if (!card) return;
    const plan = planBalanceTenders(card.settlement.balanceDue, lineValues());
    byId("fd-sum-due").textContent = money(card.settlement.balanceDue);
    byId("fd-sum-applied").textContent = money(
      fromCents(plan.nonCashCents + plan.appliedCashCents)
    );
    byId("fd-sum-change").textContent = money(fromCents(plan.changeCents));
    byId("fd-sum-remaining").textContent = money(
      fromCents(plan.remainingCents)
    );
  }

  // ---- requests ----------------------------------------------------------
  function busyOn(button: HTMLButtonElement): () => void {
    busy = true;
    const label = button.textContent;
    button.textContent = msg("msgBusy");
    button.setAttribute("aria-disabled", "true");
    cardEl.setAttribute("aria-busy", "true");
    return () => {
      busy = false;
      button.textContent = label;
      cardEl.setAttribute("aria-busy", "false");
      refreshControls();
      if (button === findButton) button.removeAttribute("aria-disabled");
    };
  }

  async function readCard(
    body: LookupBody
  ): Promise<
    | { kind: "card"; card: FrontDeskCard }
    | { kind: "refused"; errorCode: string | null; details: unknown }
  > {
    const result = await sendJsonRequest("POST", `${BASE}/lookup`, body);
    const data = result.payload?.data;
    if (result.ok && isFrontDeskCard(data)) return { kind: "card", card: data };
    return {
      kind: "refused",
      errorCode: result.ok ? "BAD_RESPONSE" : result.errorCode,
      details: result.payload?.error?.details
    };
  }

  // ---- lookup ------------------------------------------------------------
  lookupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void doLookup();
  });

  async function doLookup(): Promise<void> {
    if (busy) return;
    clearLookupError();
    const input = buildLookupBody(codeInput.value, contactInput.value);
    if (!input.ok) {
      const key =
        input.problem === "code_required"
          ? "msgCodeRequired"
          : input.problem === "code_invalid"
            ? "msgCodeInvalid"
            : input.problem === "contact_required"
              ? "msgContactRequired"
              : "msgContactInvalid";
      lookupFailed(msg(key), [
        input.field === "code" ? codeInput : contactInput
      ]);
      return;
    }
    hideResult();
    const unlock = busyOn(findButton);
    announce(msg("msgLookingUp"));
    try {
      const outcome = await readCard(input.body);
      if (outcome.kind === "refused") {
        card = null;
        identity = null;
        cardEl.hidden = true;
        const code = outcome.errorCode;
        if (code === "RESOURCE_NOT_FOUND") {
          // One neutral answer for an unknown code, a wrong customer and another
          // tenant's code (C-34): both fields are refused together.
          lookupFailed(msg("msgNotFound"), [codeInput, contactInput]);
        } else if (code === "RATE_LIMITED") {
          lookupFailed(msg("msgRateLimited"), []);
        } else if (code === "VALIDATION_ERROR") {
          // The server named the field it refused: put the refusal on it.
          const code400 = validationFields(outcome.details);
          if (code400.includes("reservationNo")) {
            lookupFailed(msg("msgCodeInvalid"), [codeInput]);
          } else {
            lookupFailed(msg("msgContactInvalid"), [contactInput]);
          }
        } else if (code === "NETWORK_ERROR") {
          lookupFailed(msg("msgNetwork"), []);
        } else if (code === "ACCESS_DENIED" || code === "FEATURE_DISABLED") {
          lookupFailed(msg(refusalKey(code)), []);
        } else {
          lookupFailed(msg("msgLookupFailed"), []);
        }
        return;
      }
      identity = input.body;
      // The contact is not needed on screen any more: drop it from the field.
      contactInput.value = "";
      resetRows();
      render(outcome.card);
      announce(fill(msg("msgFound"), { code: outcome.card.reservationNo }));
      cardHeading.focus();
    } finally {
      unlock();
    }
  }

  clearButton.addEventListener("click", () => clearAll());

  function clearAll(): void {
    card = null;
    identity = null;
    codeInput.value = "";
    contactInput.value = "";
    clearLookupError();
    clearBalanceError();
    hideResult();
    cardEl.hidden = true;
    rows.length = 0;
    tendersEl.textContent = "";
    checkInKeys.settle();
    checkOutKeys.settle();
    collectKeys.settle();
    announce(msg("msgCleared"));
    codeInput.focus();
  }

  /** Re-reads the card with the identifier kept in memory; on failure the card is dropped, never shown stale. */
  async function reloadCard(): Promise<boolean> {
    if (!identity) return false;
    const outcome = await readCard(identity);
    if (outcome.kind === "card") {
      render(outcome.card);
      return true;
    }
    card = null;
    cardEl.hidden = true;
    return false;
  }

  // ---- check-in and check-out -------------------------------------------
  async function writeStay(verb: "check-in" | "check-out"): Promise<void> {
    if (!card || busy) return;
    const button = verb === "check-in" ? checkInButton : checkOutButton;
    const keys = verb === "check-in" ? checkInKeys : checkOutKeys;
    const states = actionStates(card, { ...caps, hasSession: hasSession() });
    const state = verb === "check-in" ? states.checkIn : states.checkOut;
    if (!state.enabled) {
      // A control that cannot be used says why instead of doing nothing.
      showResult(msg(BLOCKED_REASON_KEY[state.reason]), "danger");
      return;
    }
    const reservation = card;
    const register = registerId();
    const key = keys.keyFor(
      requestSignature([verb, reservation.reservationId, register])
    );
    const unlock = busyOn(button);
    try {
      const result = await sendJsonRequest(
        "POST",
        `${BASE}/reservations/${encodeURIComponent(reservation.reservationId)}/${verb}`,
        { registerId: register },
        { "Idempotency-Key": key }
      );
      if (isOutcomeUnknown(result)) {
        // The outcome is unknown (no connection, or no error envelope behind a
        // proxy error page): the SAME key is kept, so a second press replays the
        // first outcome instead of writing twice.
        showResult(msg("msgNetwork"), "danger");
        return;
      }
      keys.settle();
      if (!result.ok) {
        await refuse(result.errorCode, result.payload?.error?.details);
        return;
      }
      const reloaded = await reloadCard();
      const text = fill(
        msg(verb === "check-in" ? "msgCheckedIn" : "msgCheckedOut"),
        { code: reservation.reservationNo }
      );
      showResult(
        reloaded
          ? `${text} ${recorded()}`
          : `${text} ${msg("msgLookupFailed")}`,
        "success"
      );
    } finally {
      unlock();
    }
  }

  checkInButton.addEventListener("click", () => void writeStay("check-in"));
  checkOutButton.addEventListener("click", () => void writeStay("check-out"));

  /** Shows a refusal of a write; a refusal that means the reservation changed also re-reads the card. */
  async function refuse(code: string | null, details: unknown): Promise<void> {
    let text = msg(refusalKey(code));
    const outstanding = outstandingFromDetails(details);
    if (outstanding !== null && code === "BALANCE_NOT_SETTLED") {
      text = `${text} ${fill(msg("msgStillOwed"), { amount: money(outstanding) })}`;
    }
    if (code === "RESOURCE_NOT_FOUND") text = msg("msgNotFoundWrite");
    if (refusalReloadsCard(code)) {
      await reloadCard();
      if (code === "INVALID_STATE") text = msg("msgStateChanged");
    }
    showResult(text, "danger");
  }

  // ---- balance collection ------------------------------------------------
  byId<HTMLButtonElement>("fd-add-tender").addEventListener("click", () =>
    addRow("cash", true)
  );

  balanceForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void collect();
  });

  /** Puts a tender refusal on the line it is about: `aria-invalid`, tied to the message, and focus. */
  function showTenderProblem(
    text: string,
    index: number | null,
    part: "amount" | "code"
  ): void {
    balanceError.textContent = text;
    balanceError.hidden = false;
    const line = rows[index ?? 0];
    if (!line) {
      balanceError.focus();
      return;
    }
    const target = part === "code" ? line.code : line.amount;
    markInvalid(target, "fd-balance-error", true);
    target.focus();
  }

  async function collect(): Promise<void> {
    if (!card || busy) return;
    clearBalanceError();
    const states = actionStates(card, { ...caps, hasSession: hasSession() });
    if (!states.collect.enabled) {
      showResult(msg(BLOCKED_REASON_KEY[states.collect.reason]), "danger");
      return;
    }
    const lines = lineValues();
    const plan = planBalanceTenders(card.settlement.balanceDue, lines);
    const problem = firstTenderProblem(plan);
    if (problem) {
      const text = msg(
        problem.problem === "no_tender"
          ? "msgNoTender"
          : problem.problem === "bad_amount"
            ? "msgBadAmount"
            : problem.problem === "two_cash"
              ? "msgTwoCash"
              : problem.problem === "code_required"
                ? "msgCodeLineRequired"
                : "msgOverpayment"
      );
      showTenderProblem(
        text,
        problem.index,
        problem.problem === "code_required" ? "code" : "amount"
      );
      return;
    }

    const reservation = card;
    const register = registerId();
    const body = buildBalanceBody(register, lines);
    // Bound to the exact tenders: editing a line is a different request, a retry
    // after a dropped connection is the same one.
    const key = collectKeys.keyFor(
      requestSignature([reservation.reservationId, body])
    );
    const unlock = busyOn(collectButton);
    try {
      const result = await sendJsonRequest(
        "POST",
        `${BASE}/reservations/${encodeURIComponent(reservation.reservationId)}/balance-payments`,
        body,
        { "Idempotency-Key": key }
      );
      if (isOutcomeUnknown(result)) {
        showResult(msg("msgNetwork"), "danger");
        return;
      }
      collectKeys.settle();
      if (!result.ok) {
        const details = result.payload?.error?.details;
        if (result.errorCode === "VALIDATION_ERROR") {
          // The server named the field it refused (a code it does not know, an
          // amount it cannot read): put the refusal on that line.
          const target = validationFields(details)
            .map(tenderFieldTarget)
            .find((found) => found !== null);
          if (target) {
            showTenderProblem(
              msg(target.part === "code" ? "msgSvNotFound" : "msgBadAmount"),
              target.index,
              target.part === "code" ? "code" : "amount"
            );
            return;
          }
        }
        await refuse(result.errorCode, details);
        return;
      }
      const data = (result.payload?.data ?? {}) as {
        balanceBefore?: unknown;
        change?: unknown;
      };
      const before =
        typeof data.balanceBefore === "string"
          ? data.balanceBefore
          : reservation.settlement.balanceDue;
      const change =
        typeof data.change === "string" && toCents(data.change) > 0n
          ? data.change
          : null;
      resetRows();
      const reloaded = await reloadCard();
      const parts: string[] = [];
      if (reloaded && card) {
        const dueNow = (card as FrontDeskCard).settlement.balanceDue;
        const received = toCents(before) - toCents(dueNow);
        parts.push(
          fill(msg("msgCollected"), {
            amount: money(fromCents(received > 0n ? received : 0n))
          })
        );
        parts.push(
          toCents(dueNow) > 0n
            ? fill(msg("msgStillOwed"), { amount: money(dueNow) })
            : msg("msgPaidInFull")
        );
      } else {
        parts.push(msg("msgLookupFailed"));
      }
      if (change !== null) {
        parts.push(fill(msg("msgChange"), { amount: money(change) }));
      }
      parts.push(recorded());
      showResult(parts.join(" "), "success");
    } finally {
      unlock();
    }
  }

  // A control that cannot be used is `aria-disabled`, not `disabled`: a press
  // still reaches `writeStay` / `collect`, which answer with the reason.
  registerEl?.addEventListener("change", () => {
    checkInKeys.settle();
    checkOutKeys.settle();
    collectKeys.settle();
    refreshControls();
  });

  // ---- keyboard ----------------------------------------------------------
  // Enter in the code field is what a scanner sends after the code: move on to
  // the contact (or look up when it is already filled) instead of failing.
  codeInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    codeInput.value = codeInput.value.trim().toUpperCase();
    if (contactInput.value.trim() === "") contactInput.focus();
    else void doLookup();
  });

  // A scan while focus is on a button or the page body: take it as the code.
  const detector = new ScanBurstDetector();
  document.addEventListener(
    "keydown",
    (event) => {
      if (dialog?.open) {
        detector.reset();
        return;
      }
      const outcome = detector.feed({
        key: event.key,
        timeStamp: event.timeStamp,
        editable: isTextEntry(event.target),
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey
      });
      if (outcome.kind === "scan") {
        event.preventDefault();
        event.stopPropagation();
        codeInput.value = outcome.code.toUpperCase();
        if (contactInput.value.trim() === "") contactInput.focus();
        else void doLookup();
      }
    },
    true
  );

  let tenantRaw: unknown = null;
  try {
    tenantRaw = JSON.parse(ds.tenantShortcuts ?? "{}") as unknown;
  } catch {
    tenantRaw = null;
  }
  const map: PosShortcutMap = resolvePosShortcuts(
    tenantRaw,
    readUserShortcuts()
  ).map;

  const handlers: Partial<Record<PosShortcutAction, () => void>> = {
    focusScan: () => {
      codeInput.focus();
      codeInput.select();
    },
    focusCustomer: () => contactInput.focus(),
    focusPayment: () => {
      const amount = rows[0]?.amount;
      if (amount && !amount.disabled && !balanceForm.hidden) amount.focus();
    },
    finalize: () => {
      if (!balanceForm.hidden && card) balanceForm.requestSubmit();
    },
    newSale: () => clearAll(),
    showHelp: () => openDialog()
  };

  document.addEventListener("keydown", (event) => {
    if (event.repeat || event.isComposing || dialog?.open) return;
    const action = actionForCombo(map, comboFromEvent(event));
    const handler = action ? handlers[action] : undefined;
    if (!handler) return;
    event.preventDefault();
    handler();
  });

  // ---- shortcut help (a native dialog: trap, Escape and focus restore are free) ----
  function openDialog(): void {
    if (!dialog || dialog.open) return;
    for (const row of dialog.querySelectorAll<HTMLElement>(
      "[data-action-id]"
    )) {
      const action = row.dataset.actionId as PosShortcutAction;
      const kbd = row.querySelector<HTMLElement>("[data-field='combo']");
      if (kbd) kbd.textContent = map[action];
    }
    dialog.showModal();
    byId("fd-shortcuts-close").focus();
  }
  byId("fd-shortcuts-open").addEventListener("click", openDialog);
  byId("fd-shortcuts-close").addEventListener("click", () => dialog?.close());

  // ---- start -------------------------------------------------------------
  hideResult();
  codeInput.focus();
}
