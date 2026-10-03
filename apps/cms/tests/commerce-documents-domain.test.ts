/**
 * The pure half of the commerce document lifecycle (Issue #286, ADR-0029):
 * numbering format, status machines, validation, the canonical content hash,
 * eligibility, exact-money comparisons, the render contract, and the registries
 * (permissions, events, lifecycle descriptors) that must agree with each other.
 * No database.
 */
import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_SEQUENCE_TYPES,
  HELD_SALE_STATUSES,
  LEGAL_QUOTATION_TRANSITIONS,
  LEGAL_WORK_ORDER_TRANSITIONS,
  QUOTATION_STATUSES,
  REVISABLE_QUOTATION_STATUSES,
  WORK_ORDER_STATUSES,
  buildHeldCart,
  canTransitionQuotation,
  canTransitionWorkOrder,
  canonicalJson,
  checkIssueEligibility,
  contentHash,
  effectiveHeldSaleStatus,
  escapeHtml,
  formatDocumentNumber,
  isQuotationVersionExpired,
  numberingPeriod,
  parseDocumentNumber,
  renderDocumentHtml,
  renderDocumentText,
  signedDifference,
  totalsDiffer,
  validateConvertQuotationInput,
  validateCreateQuotationInput,
  validateCreateWorkOrderInput,
  validateHeldSaleDecisionInput,
  validateHoldSaleInput,
  validateIssueDocumentInput,
  validateQuotationActionInput,
  validateReviseQuotationInput,
  validateWorkOrderUpdateInput,
  type DocumentSnapshot
} from "../src/modules/commerce/domain/documents";
import {
  DOCUMENT_DATA_LIFECYCLE,
  DOCUMENT_SUBJECT_DATA
} from "../src/modules/commerce/domain/documents-lifecycle";
import { commerceModule } from "../src/modules/commerce/module";
import { DOMAIN_EVENT_TYPE_REGISTRY } from "../src/modules/domain-event-runtime/domain/event-type-registry";
import {
  DEFAULT_COMMERCE_FEATURES,
  resolveCommerceFeatures
} from "../src/modules/commerce/domain/commerce-features";

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-03T03:00:00.000Z");
const DAY = 86_400_000;

describe("document numbering", () => {
  test("format and parse round-trip for every type", () => {
    expect(formatDocumentNumber("invoice", "2026", 1)).toBe("INV-2026-000001");
    expect(formatDocumentNumber("receipt", "2026", 42)).toBe("RCP-2026-000042");
    expect(formatDocumentNumber("quotation", "2027", 123456)).toBe(
      "QUO-2027-123456"
    );
    expect(formatDocumentNumber("work_order", "2026", 7)).toBe(
      "WO-2026-000007"
    );
    for (const type of DOCUMENT_SEQUENCE_TYPES) {
      const number = formatDocumentNumber(type, "2026", 99);
      expect(parseDocumentNumber(number)).toEqual({
        type,
        period: "2026",
        counter: 99
      });
    }
    // It simply grows a digit past 999999 rather than wrapping.
    expect(formatDocumentNumber("invoice", "2026", 1_000_000)).toBe(
      "INV-2026-1000000"
    );
  });

  test("a counter is a positive integer", () => {
    expect(() => formatDocumentNumber("invoice", "2026", 0)).toThrow(
      RangeError
    );
    expect(() => formatDocumentNumber("invoice", "2026", 1.5)).toThrow(
      RangeError
    );
    expect(parseDocumentNumber("XYZ-2026-000001")).toBeNull();
    expect(parseDocumentNumber("INV-26-1")).toBeNull();
  });

  test("the period is the UTC calendar year of the instant", () => {
    expect(numberingPeriod(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026");
    expect(numberingPeriod(new Date("2027-01-01T00:00:00.000Z"))).toBe("2027");
    // 02:00 on 1 Jan in Jakarta (UTC+7) is still 31 Dec UTC.
    expect(numberingPeriod(new Date("2026-12-31T19:00:00.000Z"))).toBe("2026");
  });
});

describe("status machines", () => {
  test("quotation: the documented edges and nothing else", () => {
    expect(LEGAL_QUOTATION_TRANSITIONS.draft).toEqual(["sent", "cancelled"]);
    expect(canTransitionQuotation("sent", "accepted")).toBe(true);
    expect(canTransitionQuotation("accepted", "converted")).toBe(true);
    expect(canTransitionQuotation("draft", "accepted")).toBe(false);
    expect(canTransitionQuotation("accepted", "rejected")).toBe(false);
    for (const terminal of [
      "rejected",
      "expired",
      "converted",
      "cancelled"
    ] as const) {
      expect(LEGAL_QUOTATION_TRANSITIONS[terminal]).toEqual([]);
    }
    // Every status is a key, so adding one without an edge list is a compile error.
    expect(Object.keys(LEGAL_QUOTATION_TRANSITIONS).sort()).toEqual(
      [...QUOTATION_STATUSES].sort()
    );
    expect(REVISABLE_QUOTATION_STATUSES).toEqual(["draft", "sent", "expired"]);
  });

  test("work order: the documented edges and nothing else", () => {
    expect(canTransitionWorkOrder("received", "in_progress")).toBe(true);
    expect(canTransitionWorkOrder("on_hold", "in_progress")).toBe(true);
    expect(canTransitionWorkOrder("ready", "in_progress")).toBe(true);
    expect(canTransitionWorkOrder("received", "completed")).toBe(false);
    expect(canTransitionWorkOrder("completed", "in_progress")).toBe(false);
    expect(canTransitionWorkOrder("cancelled", "received")).toBe(false);
    expect(Object.keys(LEGAL_WORK_ORDER_TRANSITIONS).sort()).toEqual(
      [...WORK_ORDER_STATUSES].sort()
    );
  });

  test("a held sale past its expiry reads expired without any job having run", () => {
    const expires = new Date(NOW.getTime() + 1000);
    expect(effectiveHeldSaleStatus("held", expires, NOW)).toBe("held");
    expect(
      effectiveHeldSaleStatus("held", expires, new Date(NOW.getTime() + 1000))
    ).toBe("expired");
    expect(
      effectiveHeldSaleStatus("resumed", expires, new Date(NOW.getTime() + DAY))
    ).toBe("resumed");
    expect(
      effectiveHeldSaleStatus(
        "discarded",
        expires,
        new Date(NOW.getTime() + DAY)
      )
    ).toBe("discarded");
    expect(HELD_SALE_STATUSES).toHaveLength(4);
  });

  test("a version expires exactly at validUntil", () => {
    const until = new Date(NOW.getTime() + DAY);
    expect(isQuotationVersionExpired(until, NOW)).toBe(false);
    expect(isQuotationVersionExpired(until, until)).toBe(true);
  });
});

describe("request validation", () => {
  test("hold: lines are ids and quantities only, ttl is bounded, a key is required", () => {
    const ok = validateHoldSaleInput(
      {
        lines: [{ productId: PRODUCT, quantity: 2 }],
        label: " Meja 4 ",
        ttlHours: 6
      },
      "key-1"
    );
    expect(ok.valid).toBe(true);
    if (!ok.valid) return;
    expect(ok.value.label).toBe("Meja 4");
    expect(ok.value.ttlHours).toBe(6);
    const cart = buildHeldCart(ok.value);
    expect(JSON.stringify(cart)).not.toContain("price");
    expect(cart.lines).toEqual([
      { productId: PRODUCT, variantId: null, quantity: 2 }
    ]);

    for (const body of [
      { lines: [] },
      { lines: [{ productId: "nope", quantity: 1 }] },
      { lines: [{ productId: PRODUCT, quantity: 0 }] },
      { lines: [{ productId: PRODUCT, quantity: 1.5 }] },
      { lines: [{ productId: PRODUCT, quantity: 10001 }] },
      { lines: [{ productId: PRODUCT, quantity: 1 }], ttlHours: 169 },
      { lines: [{ productId: PRODUCT, quantity: 1 }], ttlHours: 0 },
      { lines: [{ productId: PRODUCT, quantity: 1 }], registerId: "x" }
    ]) {
      expect(validateHoldSaleInput(body, "k").valid).toBe(false);
    }
    expect(
      validateHoldSaleInput(
        { lines: [{ productId: PRODUCT, quantity: 1 }] },
        ""
      ).valid
    ).toBe(false);
    expect(validateHeldSaleDecisionInput({}, "").valid).toBe(false);
    expect(validateHeldSaleDecisionInput({}, "k").valid).toBe(true);
  });

  test("quotation: a customer and lines are required, validity is bounded", () => {
    const base = {
      customer: { name: "Budi", phone: "0812" },
      lines: [{ productId: PRODUCT, quantity: 1 }]
    };
    const ok = validateCreateQuotationInput(base, "k", NOW);
    expect(ok.valid).toBe(true);
    if (ok.valid) {
      // The default validity is 14 days.
      expect(ok.value.validUntil.getTime()).toBe(NOW.getTime() + 14 * DAY);
    }
    expect(
      validateCreateQuotationInput({ ...base, customer: undefined }, "k", NOW)
        .valid
    ).toBe(false);
    expect(
      validateCreateQuotationInput(
        { ...base, customer: { name: "", phone: "1" } },
        "k",
        NOW
      ).valid
    ).toBe(false);
    expect(
      validateCreateQuotationInput(
        { ...base, validUntil: new Date(NOW.getTime() - 1).toISOString() },
        "k",
        NOW
      ).valid
    ).toBe(false);
    expect(
      validateCreateQuotationInput(
        {
          ...base,
          validUntil: new Date(NOW.getTime() + 181 * DAY).toISOString()
        },
        "k",
        NOW
      ).valid
    ).toBe(false);
    expect(
      validateCreateQuotationInput(
        { ...base, validUntil: "tomorrow" },
        "k",
        NOW
      ).valid
    ).toBe(false);
    expect(
      validateCreateQuotationInput({ ...base, validUntil: 5 }, "k", NOW).valid
    ).toBe(false);
    expect(
      validateReviseQuotationInput({ lines: base.lines }, "k", NOW).valid
    ).toBe(true);
    expect(validateReviseQuotationInput({}, "k", NOW).valid).toBe(false);
  });

  test("a client-supplied price is ignored: the line shape has no price field", () => {
    const parsed = validateReviseQuotationInput(
      {
        lines: [
          { productId: PRODUCT, quantity: 1, unitPrice: "1.00", price: "1.00" }
        ]
      },
      "k",
      NOW
    );
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) return;
    expect(Object.keys(parsed.value.lines[0]!).sort()).toEqual([
      "productId",
      "quantity",
      "variantId"
    ]);
  });

  test("conversion and quotation actions", () => {
    expect(validateConvertQuotationInput({}, "k")).toEqual({
      valid: true,
      value: { idempotencyKey: "k", registerId: null, acceptPriceChange: false }
    });
    expect(
      validateConvertQuotationInput({ acceptPriceChange: "yes" }, "k").valid
    ).toBe(false);
    expect(validateConvertQuotationInput({ registerId: "x" }, "k").valid).toBe(
      false
    );
    expect(validateConvertQuotationInput({}, "").valid).toBe(false);
    expect(validateQuotationActionInput({ note: "  tolak  " }, "k")).toEqual({
      valid: true,
      value: { idempotencyKey: "k", note: "tolak" }
    });
  });

  test("work order create and update", () => {
    expect(validateCreateWorkOrderInput({ title: "Servis" }, "k").valid).toBe(
      true
    );
    expect(validateCreateWorkOrderInput({}, "k").valid).toBe(false);
    expect(
      validateCreateWorkOrderInput({ title: "x", priority: "asap" }, "k").valid
    ).toBe(false);
    expect(
      validateCreateWorkOrderInput({ title: "x", orderId: "nope" }, "k").valid
    ).toBe(false);
    expect(
      validateCreateWorkOrderInput({ title: "x", dueAt: "soon" }, "k").valid
    ).toBe(false);
    expect(validateWorkOrderUpdateInput({ status: "ready" }, "k").valid).toBe(
      true
    );
    expect(validateWorkOrderUpdateInput({}, "k").valid).toBe(false);
    expect(validateWorkOrderUpdateInput({ status: "done" }, "k").valid).toBe(
      false
    );
    const clear = validateWorkOrderUpdateInput(
      { assigneeTenantUserId: null },
      "k"
    );
    expect(clear.valid).toBe(true);
    if (clear.valid) expect(clear.value.assigneeTenantUserId).toBeNull();
  });

  test("issue document", () => {
    const orderId = "22222222-2222-4222-8222-222222222222";
    expect(
      validateIssueDocumentInput({ orderId, docType: "invoice" }, "k").valid
    ).toBe(true);
    expect(
      validateIssueDocumentInput({ orderId, docType: "quotation" }, "k").valid
    ).toBe(false);
    expect(
      validateIssueDocumentInput({ orderId: "x", docType: "receipt" }, "k")
        .valid
    ).toBe(false);
  });
});

describe("issue eligibility", () => {
  test("an invoice needs an order that took effect; a receipt also needs it paid", () => {
    expect(
      checkIssueEligibility("invoice", {
        status: "pending_payment",
        paymentStatus: "unpaid"
      })
    ).toEqual({ eligible: true });
    expect(
      checkIssueEligibility("receipt", {
        status: "pending_payment",
        paymentStatus: "unpaid"
      })
    ).toEqual({ eligible: false, reason: "ORDER_NOT_PAID" });
    expect(
      checkIssueEligibility("receipt", {
        status: "paid",
        paymentStatus: "paid"
      })
    ).toEqual({ eligible: true });
    expect(
      checkIssueEligibility("invoice", {
        status: "cancelled",
        paymentStatus: "paid"
      })
    ).toEqual({ eligible: false, reason: "ORDER_NOT_FINAL" });
    expect(
      checkIssueEligibility("receipt", {
        status: "expired",
        paymentStatus: "unpaid"
      })
    ).toEqual({ eligible: false, reason: "ORDER_NOT_FINAL" });
  });
});

describe("exact money", () => {
  test("totals are compared in integer cents, never as floats", () => {
    expect(totalsDiffer("20000.00", "20000.00")).toBe(false);
    expect(totalsDiffer("20000.00", "20000.01")).toBe(true);
    expect(totalsDiffer("0.10", "0.1")).toBe(false);
    expect(signedDifference("20000.00", "25000.50")).toBe("5000.50");
    expect(signedDifference("25000.50", "20000.00")).toBe("-5000.50");
    expect(signedDifference("0.10", "0.30")).toBe("0.20");
    expect(signedDifference("1.00", "1.00")).toBe("0.00");
  });
});

describe("canonical JSON and the content hash", () => {
  test("key order and undefined do not change the hash; content does", () => {
    const a = { b: 1, a: { d: [1, 2], c: null }, u: undefined };
    const b = { a: { c: null, d: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash({ ...b, b: 2 })).not.toBe(contentHash(b));
    // Arrays keep their order.
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
    // A string that LOOKS like a number is not a number.
    expect(contentHash({ total: "1.00" })).not.toBe(contentHash({ total: 1 }));
  });
});

const SNAPSHOT: DocumentSnapshot = {
  schemaVersion: 1,
  docType: "invoice",
  number: "INV-2026-000001",
  issuedAt: "2026-10-03T03:00:00.000Z",
  currency: "IDR",
  seller: {
    name: "Toko <b>Maju</b> & Co",
    address: 'Jl. "Contoh" 1',
    phone: "0812",
    email: null
  },
  customer: { name: "<script>alert(1)</script>", phone: "0812", email: null },
  order: {
    id: "22222222-2222-4222-8222-222222222222",
    orderCode: "BJ-ABC123",
    channel: "pos",
    status: "paid",
    paymentStatus: "paid",
    createdAt: "2026-10-03T02:59:00.000Z",
    paidAt: "2026-10-03T03:00:00.000Z",
    notes: null
  },
  lines: [
    {
      name: "Kopi <Susu>",
      variantName: "Besar",
      sku: "K1",
      quantity: 2,
      unitPrice: "10000.00",
      lineTotal: "20000.00"
    }
  ],
  totals: {
    subtotal: "20000.00",
    discount: "1000.00",
    shippingCost: "0.00",
    insuranceFee: "0.00",
    tax: "2090.00",
    total: "21090.00"
  },
  payments: [
    {
      tenderType: "cash",
      kind: "payment",
      amount: "21090.00",
      at: "2026-10-03T03:00:00.000Z"
    }
  ],
  settlement: { paid: "21090.00", reversed: "0.00", outstanding: "0.00" }
};

describe("render contract", () => {
  test("escapeHtml neutralises every markup character", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;"
    );
  });

  test("html: self-contained, escaped, structured, localised, no script", () => {
    const html = renderDocumentHtml(SNAPSHOT, "en");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Sales invoice INV-2026-000001</title>");
    expect(html).toContain('<th scope="col">Item</th>');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Toko &lt;b&gt;Maju&lt;/b&gt; &amp; Co");
    expect(html).toContain("Kopi &lt;Susu&gt; (Besar)");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>Maju");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).toContain("-1000.00");
    expect(renderDocumentHtml(SNAPSHOT, "id")).toContain("Faktur penjualan");
  });

  test("text: fixed width, exact money, omits zero fee lines", () => {
    const text = renderDocumentText(SNAPSHOT, "en");
    expect(text).toContain("SALES INVOICE");
    expect(text).toContain("INV-2026-000001");
    expect(text).toContain("21090.00");
    expect(text).not.toContain("Shipping");
    expect(text).not.toContain("Insurance");
    expect(text).toContain("Discount");
    for (const line of text.split("\n")) {
      // Wrapped lines never exceed the printer width except an unbreakable name.
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  test("rendering is a pure function of the snapshot", () => {
    expect(renderDocumentHtml(SNAPSHOT, "id")).toBe(
      renderDocumentHtml(SNAPSHOT, "id")
    );
    expect(renderDocumentText(SNAPSHOT, "id")).toBe(
      renderDocumentText(SNAPSHOT, "id")
    );
  });
});

describe("registries agree", () => {
  const moduleKeys = (commerceModule.permissions ?? []).map(
    (entry) => `commerce.${entry.activityCode}.${entry.action}`
  );

  test("the thirteen permissions are declared by the module, split by resource", () => {
    const mine = moduleKeys.filter((key) =>
      /^commerce\.(held_sales|quotations|quotation_conversions|work_orders|documents)\./.test(
        key
      )
    );
    expect(mine.sort()).toEqual(
      [
        "commerce.held_sales.read",
        "commerce.held_sales.create",
        "commerce.held_sales.update",
        "commerce.held_sales.approve",
        "commerce.quotations.read",
        "commerce.quotations.create",
        "commerce.quotations.update",
        "commerce.quotation_conversions.create",
        "commerce.work_orders.read",
        "commerce.work_orders.create",
        "commerce.work_orders.update",
        "commerce.documents.read",
        "commerce.documents.create"
      ].sort()
    );
    // None of them widens an action verb the platform did not already have.
    const verbs = new Set(mine.map((key) => key.split(".")[2]));
    expect([...verbs].sort()).toEqual(["approve", "create", "read", "update"]);
  });

  test("the four events are published by the module and registered with the event runtime", () => {
    const events = [
      "awcms.commerce.quotation.accepted",
      "awcms.commerce.quotation.converted",
      "awcms.commerce.work_order.status_changed",
      "awcms.commerce.document.issued"
    ];
    const registered = new Set(
      DOMAIN_EVENT_TYPE_REGISTRY.map((entry) => entry.eventType)
    );
    for (const event of events) {
      expect(commerceModule.events?.publishes).toContain(event);
      expect(registered.has(event)).toBe(true);
    }
  });

  test("every document table answers retention; every one but the counter answers subject data", () => {
    const lifecycle = commerceModule.dataLifecycle ?? [];
    for (const descriptor of DOCUMENT_DATA_LIFECYCLE) {
      expect(lifecycle).toContain(descriptor);
      expect(descriptor.executionMode).toBe("generic");
      expect(descriptor.retentionMaxDays).toBeGreaterThanOrEqual(
        descriptor.retentionMinDays
      );
    }
    const subjects = commerceModule.subjectData ?? [];
    for (const descriptor of DOCUMENT_SUBJECT_DATA) {
      expect(subjects).toContain(descriptor);
      // Guest customers are unreachable by the subject vocabulary; staff stamps are not erased.
      expect(descriptor.erasure).toBe("retain_under_obligation");
    }
    const tables = DOCUMENT_DATA_LIFECYCLE.map(
      (descriptor) => descriptor.tableName
    );
    // The counter is purged only once its year is over: a 366-day floor means
    // even a counter created on 1 January and bumped on 31 December survives
    // the year it can still be allocated from.
    const sequences = DOCUMENT_DATA_LIFECYCLE.find(
      (descriptor) => descriptor.key === "commerce.document_sequences"
    )!;
    expect(tables).toContain("awcms_commerce_document_sequences");
    expect(sequences.cursorColumn).toBe("updated_at");
    expect(sequences.retentionMinDays).toBeGreaterThanOrEqual(366);
    expect(
      DOCUMENT_SUBJECT_DATA.map((descriptor) => descriptor.tableName)
    ).not.toContain("awcms_commerce_document_sequences");
    // A legal document is held for at least five years.
    const documents = DOCUMENT_DATA_LIFECYCLE.find(
      (d) => d.key === "commerce.documents"
    )!;
    expect(documents.retentionClass).toBe("financial_tax");
    expect(documents.retentionMinDays).toBeGreaterThanOrEqual(1825);
  });
});

describe("feature flag", () => {
  test("`documents` defaults OFF and can be switched on", () => {
    expect(DEFAULT_COMMERCE_FEATURES.documents).toBe(false);
    expect(resolveCommerceFeatures(undefined).documents).toBe(false);
    expect(
      resolveCommerceFeatures({ features: { documents: true } }).documents
    ).toBe(true);
    // A tenant that never touched the flag keeps every pre-existing default.
    expect(
      resolveCommerceFeatures({ features: { pos: false } }).documents
    ).toBe(false);
  });
});
