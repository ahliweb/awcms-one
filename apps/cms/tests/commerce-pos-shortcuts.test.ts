/**
 * Issue #292 (ADR-0032) - `domain/pos-shortcuts.ts`: combo policy, conflict
 * detection and the defaults -> tenant -> user layering.
 */
import { describe, expect, test } from "bun:test";
import {
  actionForCombo,
  checkCombo,
  comboFromEvent,
  DEFAULT_POS_SHORTCUTS,
  findShortcutConflicts,
  POS_SHORTCUT_ACTIONS,
  readTenantShortcutSettings,
  resolvePosShortcuts,
  sanitizeShortcutOverrides
} from "../src/modules/commerce/domain/pos-shortcuts";

function event(
  code: string,
  modifiers: Partial<{
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  }> = {}
) {
  return {
    code,
    key: code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers
  };
}

describe("defaults", () => {
  test("cover every action, pass the policy and never collide", () => {
    expect(Object.keys(DEFAULT_POS_SHORTCUTS).sort()).toEqual(
      [...POS_SHORTCUT_ACTIONS].sort()
    );
    for (const action of POS_SHORTCUT_ACTIONS) {
      const checked = checkCombo(DEFAULT_POS_SHORTCUTS[action]);
      expect(checked).toEqual({
        ok: true,
        combo: DEFAULT_POS_SHORTCUTS[action]
      });
    }
    expect(findShortcutConflicts(DEFAULT_POS_SHORTCUTS)).toEqual([]);
  });
});

describe("checkCombo", () => {
  test("canonicalises modifier order and case", () => {
    expect(checkCombo("shift+alt+s")).toEqual({
      ok: true,
      combo: "Alt+Shift+S"
    });
    expect(checkCombo("control+enter")).toEqual({
      ok: true,
      combo: "Ctrl+Enter"
    });
    expect(checkCombo("f2")).toEqual({ ok: true, combo: "F2" });
  });

  test("refuses a bare printable character (WCAG 2.1.4)", () => {
    for (const bare of ["s", "S", "1", "/", "?"]) {
      expect(checkCombo(bare)).toEqual({ ok: false, reason: "bare_character" });
    }
  });

  test("refuses browser-reserved function keys", () => {
    for (const key of ["F1", "F3", "F5", "F6", "F7", "F10", "F11", "F12"]) {
      expect(checkCombo(key)).toEqual({ ok: false, reason: "reserved" });
    }
    for (const key of ["F2", "F4", "F8", "F9"]) {
      expect(checkCombo(key).ok).toBe(true);
    }
  });

  test("refuses browser chords, OS keys and unshifted Alt+letter", () => {
    expect(checkCombo("Ctrl+S")).toEqual({ ok: false, reason: "reserved" });
    expect(checkCombo("Ctrl+Shift+N")).toEqual({
      ok: false,
      reason: "reserved"
    });
    expect(checkCombo("Ctrl+W")).toEqual({ ok: false, reason: "reserved" });
    expect(checkCombo("Meta+K")).toEqual({
      ok: false,
      reason: "unsupported_modifier"
    });
    expect(checkCombo("Alt+S")).toEqual({
      ok: false,
      reason: "unsupported_modifier"
    });
    expect(checkCombo("Shift+S")).toEqual({
      ok: false,
      reason: "unsupported_modifier"
    });
    expect(checkCombo("Alt+F4")).toEqual({
      ok: false,
      reason: "unsupported_modifier"
    });
    expect(checkCombo("Alt+Left")).toEqual({ ok: false, reason: "reserved" });
  });

  test("refuses keys that move focus or close dialogs", () => {
    for (const key of ["Tab", "Escape", "Enter", "Space", "ArrowDown"]) {
      expect(checkCombo(key).ok).toBe(false);
    }
  });

  test("Ctrl+Enter and Ctrl+Shift+Enter are the only Enter chords", () => {
    expect(checkCombo("Ctrl+Enter").ok).toBe(true);
    expect(checkCombo("Ctrl+Shift+Enter").ok).toBe(true);
    expect(checkCombo("Alt+Enter").ok).toBe(false);
    expect(checkCombo("Shift+Enter").ok).toBe(false);
  });

  test("malformed input", () => {
    for (const bad of ["", "+", "Alt+", "Foo+S", "Alt+Alt+S", "Alt+Shift+Ab"]) {
      expect(checkCombo(bad)).toEqual({ ok: false, reason: "malformed" });
    }
  });
});

describe("comboFromEvent", () => {
  test("uses the physical key so macOS Option and other layouts work", () => {
    expect(
      comboFromEvent({
        ...event("KeyS", { altKey: true, shiftKey: true }),
        key: "ß"
      })
    ).toBe("Alt+Shift+S");
    expect(
      comboFromEvent(event("Digit3", { altKey: true, shiftKey: true }))
    ).toBe("Alt+Shift+3");
    expect(comboFromEvent(event("F2"))).toBe("F2");
    expect(comboFromEvent(event("Enter", { ctrlKey: true }))).toBe(
      "Ctrl+Enter"
    );
    expect(comboFromEvent(event("NumpadEnter", { ctrlKey: true }))).toBe(
      "Ctrl+Enter"
    );
  });

  test("keys that are not combo-shaped yield null", () => {
    expect(comboFromEvent(event("Tab"))).toBeNull();
    expect(comboFromEvent(event("ArrowLeft", { altKey: true }))).toBeNull();
    expect(comboFromEvent(event("Escape"))).toBeNull();
  });

  test("a plain letter keypress never resolves to an action", () => {
    expect(
      actionForCombo(DEFAULT_POS_SHORTCUTS, comboFromEvent(event("KeyS")))
    ).toBeNull();
    expect(
      actionForCombo(
        DEFAULT_POS_SHORTCUTS,
        comboFromEvent(event("KeyS", { altKey: true, shiftKey: true }))
      )
    ).toBe("focusSearch");
    expect(
      actionForCombo(
        DEFAULT_POS_SHORTCUTS,
        comboFromEvent(event("Enter", { ctrlKey: true }))
      )
    ).toBe("finalize");
  });
});

describe("conflict detection", () => {
  test("reports every combo bound to more than one action", () => {
    expect(
      findShortcutConflicts({ hold: "F2", resume: "F2", newSale: "F4" })
    ).toEqual([{ combo: "F2", actions: ["hold", "resume"] }]);
  });
});

describe("sanitizeShortcutOverrides", () => {
  test("keeps valid entries canonicalised and reports the rest", () => {
    const { overrides, problems } = sanitizeShortcutOverrides({
      hold: "shift+alt+j",
      resume: "Ctrl+S",
      nope: "F2",
      newSale: 5
    });
    expect(overrides).toEqual({ hold: "Alt+Shift+J" });
    expect(problems.map((p) => [p.action, p.reason])).toEqual([
      ["resume", "reserved"],
      ["nope", "unknown_action"],
      ["newSale", "malformed"]
    ]);
  });

  test("non-objects yield nothing and never throw", () => {
    for (const raw of [null, undefined, 3, "x", [], [1]]) {
      expect(sanitizeShortcutOverrides(raw).overrides).toEqual({});
    }
  });
});

describe("resolvePosShortcuts", () => {
  test("no overrides is exactly the defaults", () => {
    expect(resolvePosShortcuts(null, null).map).toEqual(DEFAULT_POS_SHORTCUTS);
  });

  test("tenant then user overrides layer in order", () => {
    const { map } = resolvePosShortcuts(
      { hold: "Alt+Shift+J" },
      { hold: "F8", newSale: "F9" }
    );
    expect(map.hold).toBe("F8");
    expect(map.newSale).toBe("F9");
    expect(map.resume).toBe(DEFAULT_POS_SHORTCUTS.resume);
  });

  test("an override that steals another action's combo is dropped, not applied", () => {
    const resolved = resolvePosShortcuts(null, {
      hold: DEFAULT_POS_SHORTCUTS.resume
    });
    expect(resolved.map.hold).toBe(DEFAULT_POS_SHORTCUTS.hold);
    expect(resolved.map.resume).toBe(DEFAULT_POS_SHORTCUTS.resume);
    expect(resolved.problems.user).toEqual([
      { action: "hold", reason: "conflict" }
    ]);
    expect(findShortcutConflicts(resolved.map)).toEqual([]);
  });

  test("swapping two actions' combos in one layer is allowed", () => {
    const { map, problems } = resolvePosShortcuts(null, {
      hold: DEFAULT_POS_SHORTCUTS.resume,
      resume: DEFAULT_POS_SHORTCUTS.hold
    });
    expect(map.hold).toBe(DEFAULT_POS_SHORTCUTS.resume);
    expect(map.resume).toBe(DEFAULT_POS_SHORTCUTS.hold);
    expect(problems.user).toEqual([]);
  });

  test("two overrides on the same combo in one layer are both dropped", () => {
    const { map, problems } = resolvePosShortcuts(null, {
      hold: "F8",
      resume: "F8"
    });
    expect(map.hold).toBe(DEFAULT_POS_SHORTCUTS.hold);
    expect(map.resume).toBe(DEFAULT_POS_SHORTCUTS.resume);
    expect(problems.user).toHaveLength(2);
  });

  test("a hostile stored value degrades to the defaults and cannot disable an action", () => {
    const { map } = resolvePosShortcuts(
      { finalize: "Enter", hold: { x: 1 } },
      { focusScan: "F1", __proto__: "F2" }
    );
    expect(map).toEqual(DEFAULT_POS_SHORTCUTS);
    expect(Object.values(map).every((combo) => combo.length > 0)).toBe(true);
  });
});

describe("readTenantShortcutSettings", () => {
  test("reads the posShortcuts key of an effective settings document", () => {
    expect(
      readTenantShortcutSettings({ posShortcuts: { hold: "alt+shift+j" } })
    ).toEqual({ hold: "Alt+Shift+J" });
    expect(readTenantShortcutSettings({})).toEqual({});
    expect(readTenantShortcutSettings(null)).toEqual({});
  });
});
