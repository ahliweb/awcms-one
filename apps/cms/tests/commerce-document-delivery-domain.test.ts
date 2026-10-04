/**
 * Transactional document delivery - the pure half (Issue #295, ADR-0034). No
 * database. Proves: the request validator; that a message is a pure function of
 * the stored source (so an order edited after issue cannot change it) and that
 * the money in it is the snapshot's own strings, exactly; the versioned
 * template contract of both channels (a variable outside the list is never
 * substituted, markup is not interpreted); the private-link token; and that the
 * three new permission keys are declared, each enforced by exactly its own
 * route, and separate from every document, quotation and work-order key.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { listModules } from "../src/modules";
import { DEFAULT_COMMERCE_FEATURES } from "../src/modules/commerce/domain/commerce-features";
import {
  evaluateAccess,
  type AccessAction,
  type TenantContext
} from "../src/modules/identity-access/domain/access-control";
import {
  COMMERCE_DOCUMENT_DELIVERIES_ACTIVITY_CODE,
  COMMERCE_DOCUMENT_DELIVERY_OVERRIDES_ACTIVITY_CODE
} from "../src/modules/commerce/domain/commerce-permissions";
import {
  buildDocumentLinkUrl,
  buildDocumentMessage,
  buildQuotationVersionMessage,
  buildWorkOrderMessage,
  DEFAULT_LINK_TTL_HOURS,
  DOCUMENT_DELIVERY_EMAIL_VARIABLES,
  DOCUMENT_DELIVERY_TEMPLATE_VARIABLES,
  generateDocumentLinkToken,
  hashDocumentLinkToken,
  isLinkExpired,
  looksLikeDocumentLinkToken,
  MAX_LINK_TTL_HOURS,
  normalizeRecipient,
  toEmailVariables,
  validateRequestDeliveryInput
} from "../src/modules/commerce/domain/document-delivery";
import {
  contentHash,
  type DocumentSnapshot
} from "../src/modules/commerce/domain/documents";
import { renderWhatsappTemplate } from "../src/modules/commerce/domain/whatsapp-templates";

const ID = "11111111-1111-4111-8111-111111111111";
const KEY = "idem-key-1";

function snapshot(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    schemaVersion: 1,
    docType: "receipt",
    number: "RCP-2026-000007",
    issuedAt: "2026-10-04T03:00:00.000Z",
    currency: "IDR",
    seller: {
      name: "Toko <Contoh>",
      address: "Jl. Contoh 1",
      phone: "+6281200000000",
      email: null
    },
    customer: {
      name: "Siti <img src=x>",
      phone: "+6281234567890",
      email: null
    },
    order: {
      id: ID,
      orderCode: "ORD-1",
      channel: "pos",
      status: "completed",
      paymentStatus: "paid",
      createdAt: "2026-10-04T02:59:00.000Z",
      paidAt: "2026-10-04T03:00:00.000Z",
      notes: null
    },
    lines: [
      {
        name: "Servis Rutin",
        variantName: null,
        sku: "SKU-1",
        quantity: 3,
        unitPrice: "33333.33",
        lineTotal: "99999.99"
      }
    ],
    totals: {
      subtotal: "99999.99",
      discount: "0.00",
      shippingCost: "0.00",
      insuranceFee: "0.00",
      tax: "0.00",
      total: "99999.99"
    },
    payments: [],
    settlement: { paid: "99999.99", reversed: "0.00", outstanding: "0.00" },
    ...overrides
  };
}

describe("validateRequestDeliveryInput", () => {
  const base = { targetType: "document", targetId: ID, channel: "email" };

  test("accepts the minimal request and applies the defaults", () => {
    const result = validateRequestDeliveryInput(base, KEY);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value).toEqual({
      idempotencyKey: KEY,
      targetType: "document",
      targetId: ID,
      version: null,
      channel: "email",
      locale: "id",
      recipientOverride: null,
      includeLink: false,
      linkTtlHours: DEFAULT_LINK_TTL_HOURS
    });
  });

  test("rejects an unknown target, channel or locale, a non-UUID id and a missing key", () => {
    for (const body of [
      { ...base, targetType: "order" },
      { ...base, targetId: "not-a-uuid" },
      { ...base, channel: "sms" },
      { ...base, locale: "fr" }
    ]) {
      expect(validateRequestDeliveryInput(body, KEY).valid).toBe(false);
    }
    expect(validateRequestDeliveryInput(base, "").valid).toBe(false);
    expect(validateRequestDeliveryInput(null, KEY).valid).toBe(false);
  });

  test("normalises a recipient override per channel and refuses a malformed or sentinel one", () => {
    const email = validateRequestDeliveryInput(
      { ...base, recipient: "  Budi@Example.COM " },
      KEY
    );
    expect(email.valid && email.value.recipientOverride).toBe(
      "budi@example.com"
    );
    const phone = validateRequestDeliveryInput(
      { ...base, channel: "whatsapp", recipient: "0812-3456-7890" },
      KEY
    );
    expect(phone.valid && phone.value.recipientOverride).toBe("+6281234567890");
    expect(
      validateRequestDeliveryInput({ ...base, recipient: "no-at-sign" }, KEY)
        .valid
    ).toBe(false);
    expect(
      validateRequestDeliveryInput(
        { ...base, channel: "whatsapp", recipient: "+620000000000" },
        KEY
      ).valid
    ).toBe(false);
    // An empty string means "use the customer on file", not an invalid address.
    const blank = validateRequestDeliveryInput(
      { ...base, recipient: "  " },
      KEY
    );
    expect(blank.valid && blank.value.recipientOverride).toBeNull();
  });

  test("a private link is for a document only, and its lifetime is bounded", () => {
    expect(
      validateRequestDeliveryInput({ ...base, includeLink: true }, KEY).valid
    ).toBe(true);
    expect(
      validateRequestDeliveryInput(
        { ...base, targetType: "work_order", includeLink: true },
        KEY
      ).valid
    ).toBe(false);
    for (const linkTtlHours of [0, -1, 1.5, MAX_LINK_TTL_HOURS + 1, "3"]) {
      expect(
        validateRequestDeliveryInput(
          { ...base, includeLink: true, linkTtlHours },
          KEY
        ).valid
      ).toBe(false);
    }
    const max = validateRequestDeliveryInput(
      { ...base, includeLink: true, linkTtlHours: MAX_LINK_TTL_HOURS },
      KEY
    );
    expect(max.valid).toBe(true);
  });

  test("a version applies to a quotation target only", () => {
    expect(
      validateRequestDeliveryInput(
        { ...base, targetType: "quotation_version", version: 2 },
        KEY
      ).valid
    ).toBe(true);
    expect(
      validateRequestDeliveryInput({ ...base, version: 2 }, KEY).valid
    ).toBe(false);
    expect(
      validateRequestDeliveryInput(
        { ...base, targetType: "quotation_version", version: 0 },
        KEY
      ).valid
    ).toBe(false);
  });
});

describe("normalizeRecipient", () => {
  test("lower-cases an e-mail, E.164-normalises a phone, refuses garbage", () => {
    expect(normalizeRecipient("email", "A@B.co")).toBe("a@b.co");
    expect(normalizeRecipient("email", "a@b")).toBeNull();
    expect(normalizeRecipient("email", `${"a".repeat(250)}@b.co`)).toBeNull();
    expect(normalizeRecipient("whatsapp", "081234567890")).toBe(
      "+6281234567890"
    );
    expect(normalizeRecipient("whatsapp", "12")).toBeNull();
    expect(normalizeRecipient("whatsapp", "")).toBeNull();
  });
});

describe("messages are a pure function of the stored source", () => {
  test("a receipt message carries the snapshot's money strings exactly", () => {
    const message = buildDocumentMessage(snapshot(), "en", null);
    expect(message.variables.documentLabel).toBe("Payment receipt");
    expect(message.variables.documentNumber).toBe("RCP-2026-000007");
    expect(message.variables.body).toContain("99999.99");
    expect(message.variables.body).toContain("33333.33");
    // Three times 33333.33 is 99999.99 - no float arithmetic ever rounded it.
    expect(message.variables.body).not.toContain("100000");
    expect(message.variables.link).toBe("");
  });

  test("the same snapshot always yields the same message and hash; a changed snapshot does not", () => {
    const a = buildDocumentMessage(snapshot(), "id", null);
    const b = buildDocumentMessage(snapshot(), "id", null);
    expect(b).toEqual(a);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const changed = buildDocumentMessage(
      snapshot({
        totals: { ...snapshot().totals, total: "1.00" }
      }),
      "id",
      null
    );
    expect(changed.contentHash).not.toBe(a.contentHash);
  });

  test("the builder's signature has no order input: nothing live can reach a message", async () => {
    const source = await readFile(
      "src/modules/commerce/domain/document-delivery.ts",
      "utf8"
    );
    expect(source).not.toMatch(/awcms_commerce_orders|fetchOrder/);
    const directory = await readFile(
      "src/modules/commerce/application/document-delivery-directory.ts",
      "utf8"
    );
    expect(directory).not.toMatch(
      /FROM awcms_commerce_orders|fetchOrderDetailForAdmin|toAdminOrderRecord/
    );
  });

  test("locale selects the labels", () => {
    expect(
      buildDocumentMessage(snapshot(), "id", null).variables.documentLabel
    ).toBe("Struk pembayaran");
    expect(
      buildDocumentMessage(snapshot({ docType: "invoice" }), "en", null)
        .variables.documentLabel
    ).toBe("Sales invoice");
  });

  test("the link line carries the URL and the expiry day, in the chosen language", () => {
    const expiresAt = new Date("2026-10-07T05:00:00.000Z");
    const url = "https://shop.example.test/api/x";
    const en = buildDocumentMessage(snapshot(), "en", { url, expiresAt });
    expect(en.variables.link).toBe(
      "Open the document (valid until 2026-10-07): https://shop.example.test/api/x"
    );
    const id = buildDocumentMessage(snapshot(), "id", { url, expiresAt });
    expect(id.variables.link).toContain("berlaku sampai 2026-10-07");
  });

  test("a quotation message is the version's lines and totals, and names the validity", () => {
    const message = buildQuotationVersionMessage(
      {
        number: "QUO-2026-000003",
        version: 2,
        validUntil: new Date("2026-10-20T00:00:00.000Z"),
        lines: [
          {
            name: "Servis",
            variantName: "Besar",
            quantity: 2,
            unitPrice: "10000.00",
            lineTotal: "20000.00"
          },
          {
            name: null,
            variantName: null,
            quantity: 1,
            unitPrice: "5000.50",
            lineTotal: "5000.50"
          }
        ],
        subtotal: "25000.50",
        discount: "0.00",
        tax: "2750.06",
        total: "27750.56",
        customerName: "Pak Budi"
      },
      "Toko Contoh",
      "en"
    );
    expect(message.variables.documentLabel).toBe("Quotation");
    expect(message.variables.documentNumber).toBe("QUO-2026-000003");
    expect(message.variables.body).toContain("Version: 2");
    expect(message.variables.body).toContain("Valid until: 2026-10-20");
    expect(message.variables.body).toContain("Servis (Besar)");
    expect(message.variables.body).toContain("Item");
    expect(message.variables.body).toContain("Total: 27750.56");
    expect(message.variables.body).not.toContain("Discount");
  });

  test("a work-order notice states status and target date and nothing a staff member wrote", () => {
    const message = buildWorkOrderMessage(
      {
        number: "WO-2026-000009",
        status: "ready",
        dueAt: new Date("2026-10-10T02:00:00.000Z")
      },
      "Toko Contoh",
      "id"
    );
    expect(message.variables.documentLabel).toBe("Perintah kerja");
    expect(message.variables.body).toBe(
      "Status: Siap diambil\nTarget selesai: 2026-10-10"
    );
    const noDue = buildWorkOrderMessage(
      { number: "WO-1", status: "received", dueAt: null },
      "Toko",
      "en"
    );
    expect(noDue.variables.body).toBe("Status: Received");
  });
});

describe("the versioned template contract", () => {
  const variables = buildDocumentMessage(snapshot(), "en", null).variables;

  test("every builder returns exactly the contract's variables", () => {
    expect(Object.keys(variables).sort()).toEqual(
      [...DOCUMENT_DELIVERY_TEMPLATE_VARIABLES].sort()
    );
    expect(
      Object.keys(
        buildWorkOrderMessage(
          { number: "WO-1", status: "ready", dueAt: null },
          "T",
          "id"
        ).variables
      ).sort()
    ).toEqual([...DOCUMENT_DELIVERY_TEMPLATE_VARIABLES].sort());
  });

  test("the e-mail mapping covers derived.transactional's variables and nothing else", () => {
    const email = toEmailVariables(variables);
    expect(Object.keys(email).sort()).toEqual(
      [...DOCUMENT_DELIVERY_EMAIL_VARIABLES].sort()
    );
    expect(email.subject).toBe(
      "Payment receipt RCP-2026-000007 - Toko <Contoh>"
    );
    expect(email.body).toBe(variables.body);
  });

  test("the WhatsApp template substitutes only its own variables and leaves markup literal", () => {
    const rendered = renderWhatsappTemplate("commerce.document", {
      ...variables,
      surprise: "must not appear"
    });
    expect(rendered).toContain("Payment receipt RCP-2026-000007");
    expect(rendered).toContain("Toko <Contoh>");
    // The customer's name went in verbatim as text: a plain-text channel has no
    // markup to escape, and nothing here interprets it.
    expect(rendered).toContain("Siti <img src=x>");
    expect(rendered).not.toContain("must not appear");
    expect(rendered).not.toContain("{{");
  });

  test("a placeholder that is not in the contract stays literal", () => {
    const rendered = renderWhatsappTemplate("commerce.document", {
      documentLabel: "L",
      documentNumber: "N",
      storeName: "S",
      body: "{{unknown}}",
      link: ""
    });
    expect(rendered).toContain("{{unknown}}");
    expect(rendered.startsWith("L N")).toBe(true);
  });
});

describe("the private link token", () => {
  test("is opaque, prefixed, 256 bits, stored only as a sha256", () => {
    const token = generateDocumentLinkToken();
    expect(looksLikeDocumentLinkToken(token)).toBe(true);
    expect(token).not.toContain(ID);
    expect(generateDocumentLinkToken()).not.toBe(token);
    const hash = hashDocumentLinkToken(token);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hash).not.toContain(token.slice(3));
    expect(hashDocumentLinkToken(token)).toBe(hash);
  });

  test("a malformed token is refused before any lookup", () => {
    for (const value of [
      "",
      "dl_",
      "dl_short",
      `cs_${"a".repeat(43)}`,
      `dl_${"!".repeat(43)}`,
      ID,
      null
    ]) {
      expect(looksLikeDocumentLinkToken(value)).toBe(false);
    }
  });

  test("a link is usable strictly before its expiry instant", () => {
    const expiry = new Date("2026-10-07T00:00:00.000Z");
    expect(isLinkExpired(expiry, new Date("2026-10-06T23:59:59.999Z"))).toBe(
      false
    );
    expect(isLinkExpired(expiry, expiry)).toBe(true);
    expect(isLinkExpired(expiry, new Date("2026-10-08T00:00:00.000Z"))).toBe(
      true
    );
  });

  test("the URL joins the base and the token without a doubled slash", () => {
    expect(buildDocumentLinkUrl("https://a.test/", "dl_x")).toBe(
      "https://a.test/api/v1/commerce/storefront/document-links/dl_x"
    );
  });
});

describe("the stored snapshot stays tamper-evident for delivery", () => {
  test("a snapshot whose content no longer hashes to its stored hash is detectable by the same function the directory uses", () => {
    const stored = snapshot();
    const hash = contentHash(stored);
    expect(contentHash(structuredClone(stored))).toBe(hash);
    const tampered = structuredClone(stored);
    tampered.totals.total = "1.00";
    expect(contentHash(tampered)).not.toBe(hash);
  });
});

describe("delivery permissions", () => {
  const declared = new Set(
    (
      listModules().find((module) => module.key === "commerce")?.permissions ??
      []
    ).map(
      (permission) => `commerce.${permission.activityCode}.${permission.action}`
    )
  );
  const KEYS = [
    "commerce.document_deliveries.read",
    "commerce.document_deliveries.create",
    "commerce.document_delivery_overrides.create"
  ];

  test("the module declares exactly the three keys", () => {
    for (const key of KEYS) expect(declared.has(key)).toBe(true);
    expect(
      [...declared].filter((key) => /^commerce\.document_deliver/.test(key))
        .length
    ).toBe(3);
  });

  test("the route enforces read and create, and consults the override key lazily", async () => {
    const source = await readFile(
      "src/pages/api/v1/commerce/document-deliveries/index.ts",
      "utf8"
    );
    expect(source).toContain(COMMERCE_DOCUMENT_DELIVERIES_ACTIVITY_CODE);
    expect(source).toContain(
      COMMERCE_DOCUMENT_DELIVERY_OVERRIDES_ACTIVITY_CODE
    );
    expect(source).toContain('action: "read"');
    expect(source).toContain('action: "create"');
    expect(source).toContain("requireDocumentDeliveryFeature(tx, tenantId)");
    expect(source).toContain("requireIdempotencyKey(request)");
    expect(source).not.toContain("COMMERCE_POS_ACTIVITY_CODE");
  });

  const CONTEXT: TenantContext = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    tenantUserId: "22222222-2222-4222-8222-222222222222",
    identityId: "33333333-3333-4333-8333-333333333333",
    roles: ["cashier"]
  };
  const allowed = (keys: Set<string>, key: string): boolean => {
    const [, activityCode, action] = key.split(".") as [
      string,
      string,
      AccessAction
    ];
    return evaluateAccess(
      CONTEXT,
      { moduleKey: "commerce", activityCode, action },
      keys
    ).allowed;
  };

  test("each key is its own authority, and no document, quotation or work-order key implies one", () => {
    for (const key of KEYS) {
      for (const other of KEYS) {
        expect(allowed(new Set([key]), other)).toBe(other === key);
      }
    }
    const neighbours = new Set([
      "commerce.documents.read",
      "commerce.documents.create",
      "commerce.quotations.read",
      "commerce.quotations.update",
      "commerce.work_orders.read",
      "commerce.work_orders.update",
      "commerce.pos.create"
    ]);
    for (const key of KEYS) expect(allowed(neighbours, key)).toBe(false);
  });

  test("the feature defaults OFF, like documents and register before it", () => {
    expect(DEFAULT_COMMERCE_FEATURES.documentDelivery).toBe(false);
  });
});
