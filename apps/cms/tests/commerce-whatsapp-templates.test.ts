import { describe, expect, test } from "bun:test";

import {
  isKnownWhatsappTemplateKey,
  renderWhatsappTemplate,
  whatsappTemplateVariables,
  WHATSAPP_TEMPLATE_KEYS
} from "../src/modules/commerce/domain/whatsapp-templates";

describe("whatsapp-templates — registry (Issue #108)", () => {
  test("registers exactly the three D5/D7/D9 keys", () => {
    expect([...WHATSAPP_TEMPLATE_KEYS]).toEqual([
      "commerce.customer_otp",
      "commerce.order_paid",
      "commerce.campaign"
    ]);
  });

  test("isKnownWhatsappTemplateKey rejects an unregistered key", () => {
    expect(isKnownWhatsappTemplateKey("commerce.customer_otp")).toBe(true);
    expect(isKnownWhatsappTemplateKey("commerce.not_a_key")).toBe(false);
  });

  test("customer_otp allowlists exactly code/expiresInMinutes/storeName", () => {
    expect(whatsappTemplateVariables("commerce.customer_otp")).toEqual([
      "code",
      "expiresInMinutes",
      "storeName"
    ]);
  });
});

describe("renderWhatsappTemplate — {{var}} rendering with an allowlist (Issue #108)", () => {
  test("substitutes every allowlisted variable", () => {
    const rendered = renderWhatsappTemplate("commerce.customer_otp", {
      code: "123456",
      expiresInMinutes: "10",
      storeName: "Toko Uji"
    });

    expect(rendered).toContain("123456");
    expect(rendered).toContain("10 menit");
    expect(rendered).toContain("Toko Uji");
  });

  test("an absent variable renders as empty, not as the literal placeholder", () => {
    const rendered = renderWhatsappTemplate("commerce.customer_otp", {
      code: "123456"
    });

    expect(rendered).not.toContain("{{expiresInMinutes}}");
    expect(rendered).not.toContain("{{storeName}}");
  });

  test("a variable NOT in the template's own allowlist is never substituted, even if supplied", () => {
    const rendered = renderWhatsappTemplate("commerce.customer_otp", {
      code: "123456",
      expiresInMinutes: "10",
      storeName: "Toko Uji",
      // Not in commerce.customer_otp's allowlist — must be ignored entirely,
      // it has no `{{...}}` placeholder in that template's body to begin
      // with, so this only proves the function does not throw or leak it.
      injected: "should never appear"
    });

    expect(rendered).not.toContain("should never appear");
  });
});
