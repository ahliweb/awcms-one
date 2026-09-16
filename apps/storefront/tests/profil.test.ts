import { describe, expect, test } from "bun:test";
import { mergeSiteIdentity, parseSocialLinks } from "../src/lib/awcms/profil";
import { DEFAULT_IDENTITY } from "../src/config/site";

const EMPTY_PAYLOAD = {
  tagline: null,
  copyrightNotice: null,
  logoMediaId: null,
  faviconMediaId: null,
  editorialAddress: null,
  contactEmail: null,
  contactPhone: null,
  whatsappNumber: null,
  socialLinks: [],
  siteName: null,
  organizationName: null,
  organizationLogoMediaId: null,
  defaultSocialMediaId: null
};

describe("lib/awcms/profil: parseSocialLinks", () => {
  test("keeps only http(s) links with a non-empty platform", () => {
    const links = parseSocialLinks([
      { platform: "Instagram", url: "https://instagram.com/bjekmart" },
      { platform: "Bad", url: "javascript:alert(1)" },
      { platform: "", url: "https://example.test" },
      { platform: "NoUrl" },
      "not-an-object",
      null
    ]);

    expect(links).toEqual([{ platform: "Instagram", url: "https://instagram.com/bjekmart" }]);
  });

  test("a non-array input yields an empty list rather than throwing", () => {
    expect(parseSocialLinks(null)).toEqual([]);
    expect(parseSocialLinks(undefined)).toEqual([]);
    expect(parseSocialLinks("nope")).toEqual([]);
  });
});

describe("lib/awcms/profil: mergeSiteIdentity", () => {
  test("an all-null payload (the degraded/403/404 case) falls back to DEFAULT_IDENTITY throughout", () => {
    const identity = mergeSiteIdentity(EMPTY_PAYLOAD);

    expect(identity.name).toBe(process.env.SITE_NAME ?? DEFAULT_IDENTITY.name);
    expect(identity.description).toBe(process.env.SITE_DESCRIPTION ?? DEFAULT_IDENTITY.description);
    expect(identity.address).toBe(DEFAULT_IDENTITY.address);
    expect(identity.contactEmail).toBe(DEFAULT_IDENTITY.contactEmail);
    expect(identity.contactPhone).toBe(DEFAULT_IDENTITY.contactPhone);
    expect(identity.socialLinks).toEqual([]);
  });

  test("a CMS value is preferred over the hardcoded default when present", () => {
    const identity = mergeSiteIdentity({
      ...EMPTY_PAYLOAD,
      siteName: "Toko CMS",
      tagline: "Tagline dari CMS",
      contactEmail: "cms@example.test",
      editorialAddress: "Alamat dari CMS"
    });

    if (!process.env.SITE_NAME) expect(identity.name).toBe("Toko CMS");
    if (!process.env.SITE_DESCRIPTION) expect(identity.description).toBe("Tagline dari CMS");
    expect(identity.contactEmail).toBe("cms@example.test");
    expect(identity.address).toBe("Alamat dari CMS");
  });

  test("logoMediaId/faviconMediaId pass through unresolved (issue #24's documented deviation)", () => {
    const identity = mergeSiteIdentity({
      ...EMPTY_PAYLOAD,
      logoMediaId: "abc-123",
      faviconMediaId: "def-456"
    });

    expect(identity.logoMediaId).toBe("abc-123");
    expect(identity.faviconMediaId).toBe("def-456");
  });
});
