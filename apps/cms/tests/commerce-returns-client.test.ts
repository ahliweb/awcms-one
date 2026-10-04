/**
 * The return wizard's pure logic (Issue #287, ADR-0033): which problem stops
 * step 1, and the exact request body it sends. No DOM.
 */
import { describe, expect, test } from "bun:test";

import {
  buildReturnPayload,
  readPositiveInt,
  validateLines,
  type WizardLine,
  type WizardRefund
} from "../src/lib/ui/commerce-returns-client";

const ITEM = "11111111-1111-4111-8111-111111111111";
const ITEM_2 = "22222222-2222-4222-8222-222222222222";

const line = (overrides: Partial<WizardLine> = {}): WizardLine => ({
  orderItemId: ITEM,
  remaining: 5,
  quantity: 2,
  reason: "defective",
  disposition: "restock",
  ...overrides
});

const REFUND: WizardRefund = {
  mode: "original_tender",
  shippingRefund: false,
  registerSessionId: null
};

describe("validateLines", () => {
  test("a valid selection has no problem", () => {
    expect(validateLines([line()])).toBeNull();
  });

  test("nothing selected, an incomplete line and too many units are each their own problem", () => {
    expect(validateLines([line({ quantity: 0 })])).toBe("none_selected");
    expect(validateLines([])).toBe("none_selected");
    expect(validateLines([line({ reason: "" })])).toBe("incomplete");
    expect(validateLines([line({ disposition: "" })])).toBe("incomplete");
    expect(validateLines([line({ quantity: 6 })])).toBe("too_many");
  });

  test("a line with quantity 0 is ignored even if it lacks a reason", () => {
    expect(
      validateLines([
        line(),
        line({ orderItemId: ITEM_2, quantity: 0, reason: "" })
      ])
    ).toBeNull();
  });
});

describe("buildReturnPayload", () => {
  test("sends only the selected lines, with reason and disposition, and the refund choice", () => {
    const body = buildReturnPayload({
      lines: [line(), line({ orderItemId: ITEM_2, quantity: 0 })],
      refund: REFUND,
      exchange: false,
      note: "  box was open  ",
      shippingAmount: "5000.00"
    });
    expect(body).toEqual({
      kind: "return",
      note: "box was open",
      lines: [
        {
          orderItemId: ITEM,
          quantity: 2,
          reason: "defective",
          disposition: "restock"
        }
      ],
      refund: {
        destination: "original_tender",
        shippingRefund: null,
        registerSessionId: null
      }
    });
  });

  test("shipping, the drawer and an exchange are carried through; 'no refund' sends null", () => {
    const withShipping = buildReturnPayload({
      lines: [line()],
      refund: {
        mode: "store_credit",
        shippingRefund: true,
        registerSessionId: ITEM_2
      },
      exchange: true,
      note: "",
      shippingAmount: "5000.00"
    });
    expect(withShipping).toMatchObject({
      kind: "exchange",
      note: null,
      refund: {
        destination: "store_credit",
        shippingRefund: "5000.00",
        registerSessionId: ITEM_2
      }
    });
    const none = buildReturnPayload({
      lines: [line()],
      refund: { ...REFUND, mode: "none" },
      exchange: false,
      note: "",
      shippingAmount: null
    });
    expect(none.refund).toBeNull();
  });

  test("the body carries no money amount: the server values every line", () => {
    const body = JSON.stringify(
      buildReturnPayload({
        lines: [line()],
        refund: REFUND,
        exchange: false,
        note: "",
        shippingAmount: null
      })
    );
    expect(body).not.toMatch(/amount|refundValue|goodsGross/i);
  });
});

describe("readPositiveInt", () => {
  test("only positive whole numbers count", () => {
    expect(readPositiveInt("3")).toBe(3);
    expect(readPositiveInt(" 2 ")).toBe(2);
    for (const bad of ["", "0", "-1", "1.5", "x"]) {
      expect(readPositiveInt(bad)).toBe(0);
    }
  });
});
