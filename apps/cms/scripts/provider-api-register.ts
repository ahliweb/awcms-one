/**
 * Register of the third-party provider APIs this repository talks to
 * (Issue #1173) — what version or surface the code uses, where, and when a
 * maintainer last read that provider's changelog.
 *
 * `bun run deps:provider-changelog:check` enforces three things against it:
 *
 * 1. **The register matches the code.** Every `pins` literal must still appear
 *    in its file. Bump the version in code and forget the register, and the gate
 *    fails; the register cannot describe a version nobody uses.
 * 2. **The code matches the register.** Every non-test source file that names a
 *    provider host (`PROVIDER_HOSTS`) must be listed in an entry's `files`. A new
 *    connector that nobody registered fails the gate instead of silently having
 *    no changelog owner.
 * 3. **Review is not stale.** `lastReview` (or, before the first review,
 *    `recordedOn`) plus `maxAgeDays` is the deadline. Past it the gate is red;
 *    the weekly workflow warns `WARN_DAYS` ahead and opens an issue.
 *
 * ## What `lastReview` means
 *
 * The date a MAINTAINER read the provider's changelog and confirmed the pinned
 * version/surface is still supported and no breaking change applies. It is not
 * set by a script, and it is never copied forward to make a gate green: a
 * review that did not happen is `null`, and an entry with `null` runs on
 * `recordedOn` until a person actually reads the changelog.
 *
 * Changelog URLs are for the human; the gate does not fetch them (a gate that
 * needed provider uptime would make PR checks depend on third parties).
 *
 * A downstream workspace keeps its own register of the same shape and passes it
 * with `--register <file>` (and `--src <dir>` for its source root).
 */
export type ProviderEntry = {
  id: string;
  provider: string;
  surface: string;
  /** `active` = code talks to it; `planned` = recorded, no code yet (files must be empty). */
  status: "active" | "planned";
  /** Hostnames of `PROVIDER_HOSTS` this entry owns. A source file naming one must be in `files`. */
  hosts: readonly string[];
  /** What the code uses, in the provider's own words. */
  usedVersion: string;
  /** Where a maintainer reads what changed. */
  changelogUrl: string;
  /** Literal that must appear in `file` while this entry is true. */
  pins: readonly { file: string; literal: string }[];
  /** Every source file that names this provider's host (comments included). */
  files: readonly string[];
  /** ISO date this entry's pins were last read from the code. */
  recordedOn: string;
  /** ISO date a maintainer last read the changelog, or null if never. */
  lastReview: string | null;
  /** Re-review at least this often. */
  maxAgeDays: number;
  owner: string;
  note?: string;
};

/** Hostnames that identify a provider call site in source. */
export const PROVIDER_HOSTS: readonly string[] = [
  "graph.facebook.com",
  "graph.instagram.com",
  "api.telegram.org",
  "api.mailketing.co.id",
  "fcm.googleapis.com",
  "www.googleapis.com",
  "oauth2.googleapis.com",
  "open.tiktokapis.com",
  "business-api.tiktok.com",
  "api.fonnte.com",
  "api.starsender.online",
  "api.cloudflare.com",
  "challenges.cloudflare.com",
  "api.github.com",
  // awcms-one: the `commerce` module's own providers (see the register tail).
  "api.midtrans.com",
  "api.sandbox.midtrans.com",
  "app.midtrans.com",
  "app.sandbox.midtrans.com",
  "rajaongkir.komerce.id"
];

/** Warn this many days before a review is due. */
export const WARN_DAYS = 14;

export const PROVIDER_REGISTER: readonly ProviderEntry[] = [
  {
    id: "meta-graph-facebook-pages",
    hosts: ["graph.facebook.com", "graph.instagram.com"],
    provider: "Meta Graph API",
    surface:
      "Facebook Pages publishing (`/{page-id}/feed`, `/{page-id}/photos`)",
    status: "active",
    usedVersion: "Graph API v27.0",
    changelogUrl: "https://developers.facebook.com/docs/graph-api/changelog",
    pins: [
      {
        file: "src/modules/social-publishing/infrastructure/facebook-pages-adapter.ts",
        literal: 'FACEBOOK_GRAPH_API_VERSION = "v27.0"'
      }
    ],
    files: [
      "src/modules/social-publishing/infrastructure/facebook-pages-adapter.ts"
    ],
    recordedOn: "2026-11-14",
    lastReview: null,
    maxAgeDays: 90,
    owner: "maintainer",
    note: "Graph versions are supported for a limited window and then silently upgraded by Meta; read the versions page, not only the changelog."
  },
  {
    id: "meta-whatsapp-cloud",
    hosts: ["graph.facebook.com"],
    provider: "Meta WhatsApp Business Cloud API",
    surface: "Message send (`/{phone-number-id}/messages`) and webhooks",
    status: "active",
    usedVersion:
      "Graph API v21.0 (default; WHATSAPP_META_API_VERSION overrides)",
    changelogUrl:
      "https://developers.facebook.com/docs/whatsapp/cloud-api/changelog",
    pins: [
      {
        file: "src/modules/whatsapp-delivery/domain/whatsapp-config.ts",
        literal: 'WHATSAPP_META_DEFAULT_API_VERSION = "v21.0"'
      }
    ],
    files: [
      "src/modules/whatsapp-delivery/infrastructure/meta-cloud-provider.ts"
    ],
    recordedOn: "2026-11-14",
    lastReview: null,
    maxAgeDays: 90,
    owner: "maintainer",
    note: "The pin is the code default only: a deployment may override it with `WHATSAPP_META_API_VERSION`, which the gate cannot see, so at review also ask what the deployed value is. The default here (v21.0) is older than the Graph version the Facebook Pages connector uses (v27.0). Whether that gap is intended is a question for the first review."
  },
  {
    id: "telegram-bot-api",
    hosts: ["api.telegram.org"],
    provider: "Telegram Bot API",
    surface: "Bot API methods (delivery and engagement)",
    status: "active",
    usedVersion: "Bot API (unversioned: the host serves the current API)",
    changelogUrl: "https://core.telegram.org/bots/api-changelog",
    pins: [
      {
        file: "src/modules/telegram-delivery/domain/telegram-constants.ts",
        literal: 'TELEGRAM_API_HOST = "api.telegram.org"'
      },
      {
        file: "src/modules/telegram-engagement/infrastructure/bot-api-client.ts",
        literal: 'TELEGRAM_API_HOST = "api.telegram.org"'
      }
    ],
    files: [
      "src/modules/telegram-delivery/domain/telegram-constants.ts",
      "src/modules/telegram-delivery/domain/telegram-redaction.ts",
      "src/modules/telegram-delivery/infrastructure/telegram-http-client.ts",
      "src/modules/telegram-delivery/module.ts",
      "src/modules/telegram-engagement/infrastructure/bot-api-client.ts",
      "src/modules/telegram-engagement/module.ts"
    ],
    recordedOn: "2026-11-14",
    lastReview: null,
    maxAgeDays: 90,
    owner: "maintainer",
    note: "There is no version to pin: Telegram changes the API in place. The review is the only protection, so read each entry since the last review."
  },
  {
    id: "mailketing-rest",
    hosts: ["api.mailketing.co.id"],
    provider: "Mailketing",
    surface: "Transactional email REST API and webhooks",
    status: "active",
    usedVersion:
      "REST v1 (default); v2 behind an explicit switch, contract unverified",
    changelogUrl: "https://api.mailketing.co.id/docs/",
    pins: [
      {
        file: "src/modules/email/domain/mailketing-v2-contract.ts",
        literal: 'MAILKETING_API_VERSIONS = ["v1", "v2"]'
      },
      {
        file: "src/modules/email/infrastructure/mailketing-provider.ts",
        literal: 'DEFAULT_BASE_URL = "https://api.mailketing.co.id"'
      }
    ],
    files: [
      "src/modules/email/domain/mailketing-v2-contract.ts",
      "src/modules/email/domain/mailketing-webhook.ts",
      "src/modules/email/infrastructure/mailketing-provider.ts"
    ],
    recordedOn: "2026-11-14",
    lastReview: null,
    maxAgeDays: 120,
    owner: "maintainer",
    note: "The provider publishes docs, not a dated changelog; compare the docs against the contract file at each review."
  },
  {
    id: "google-fcm-http-v1",
    hosts: [
      "fcm.googleapis.com",
      "www.googleapis.com",
      "oauth2.googleapis.com"
    ],
    provider: "Google Firebase Cloud Messaging",
    surface:
      "HTTP v1 send (`/v1/projects/{projectId}/messages:send`) with a service-account OAuth token",
    status: "active",
    usedVersion: "FCM HTTP v1, OAuth scope firebase.messaging",
    changelogUrl: "https://firebase.google.com/support/releases",
    pins: [
      {
        file: "src/modules/push-delivery/domain/fcm-credentials.ts",
        literal:
          "https://fcm.googleapis.com/v1/projects/${encodeURIComponent(credential.projectId)}/messages:send"
      },
      {
        file: "src/modules/push-delivery/domain/fcm-credentials.ts",
        literal: "https://www.googleapis.com/auth/firebase.messaging"
      }
    ],
    files: [
      "src/modules/push-delivery/domain/fcm-credentials.ts",
      "src/modules/push-delivery/domain/push-endpoint.ts",
      "src/modules/push-delivery/domain/web-push-error-mapping.ts",
      // awcms-one: commerce's customer push recognises the same endpoint host.
      "src/modules/commerce/domain/customer-push-endpoint.ts"
    ],
    recordedOn: "2026-11-14",
    lastReview: null,
    maxAgeDays: 120,
    owner: "maintainer"
  },
  {
    id: "fonnte-whatsapp",
    hosts: ["api.fonnte.com"],
    provider: "Fonnte",
    surface: "WhatsApp send (`POST /send`), an unofficial gateway",
    status: "active",
    usedVersion: "Unversioned HTTP API (`/send`)",
    changelogUrl: "https://docs.fonnte.com/",
    pins: [
      {
        file: "src/modules/whatsapp-delivery/infrastructure/fonnte-provider.ts",
        literal: 'FONNTE_SEND_URL = "https://api.fonnte.com/send"'
      }
    ],
    files: ["src/modules/whatsapp-delivery/infrastructure/fonnte-provider.ts"],
    recordedOn: "2026-11-14",
    lastReview: null,
    maxAgeDays: 90,
    owner: "maintainer",
    note: "Unofficial gateway with no dated changelog; compare its docs with the adapter at each review."
  },
  {
    id: "starsender-whatsapp",
    hosts: ["api.starsender.online"],
    provider: "StarSender",
    surface: "WhatsApp send (`POST /api/send`), an unofficial gateway",
    status: "active",
    usedVersion: "Unversioned HTTP API (`/api/send`)",
    changelogUrl: "https://docs.starsender.online/",
    pins: [
      {
        file: "src/modules/whatsapp-delivery/domain/starsender-contract.ts",
        literal:
          'STARSENDER_SEND_URL = "https://api.starsender.online/api/send"'
      }
    ],
    files: ["src/modules/whatsapp-delivery/domain/starsender-contract.ts"],
    recordedOn: "2026-11-14",
    lastReview: null,
    maxAgeDays: 90,
    owner: "maintainer",
    note: "The contract file records that its evidence is one public docs page; re-read that page at each review."
  },
  {
    id: "cloudflare-api",
    hosts: ["api.cloudflare.com"],
    provider: "Cloudflare API",
    surface: "Tenant-domain DNS records and CDN cache purge",
    status: "active",
    usedVersion: "REST `/client/v4`",
    changelogUrl: "https://developers.cloudflare.com/changelog/",
    pins: [
      {
        file: "src/modules/tenant-domain/infrastructure/cloudflare-dns-adapter.ts",
        literal: 'DEFAULT_API_BASE_URL = "https://api.cloudflare.com/client/v4"'
      },
      {
        file: "src/lib/edge-cache/cdn-purge-config.ts",
        literal: 'DEFAULT_CDN_API_BASE = "https://api.cloudflare.com/client/v4"'
      }
    ],
    files: [
      "src/lib/edge-cache/cdn-purge-config.ts",
      "src/modules/tenant-domain/infrastructure/cloudflare-dns-adapter.ts"
    ],
    recordedOn: "2026-11-14",
    lastReview: null,
    maxAgeDays: 150,
    owner: "maintainer"
  },
  {
    id: "cloudflare-turnstile",
    hosts: ["challenges.cloudflare.com"],
    provider: "Cloudflare Turnstile",
    surface:
      "Server-side token verification (`siteverify`) and the client widget script, a login/registration abuse control",
    status: "active",
    usedVersion: "Turnstile `v0` (siteverify and widget script)",
    changelogUrl: "https://developers.cloudflare.com/turnstile/changelog/",
    pins: [
      {
        file: "src/lib/security/turnstile.ts",
        literal:
          '  "https://challenges.cloudflare.com/turnstile/v0/siteverify";'
      }
    ],
    files: [
      "src/lib/security/security-headers.ts",
      "src/lib/security/turnstile.ts",
      "src/pages/forgot-password.astro",
      "src/pages/login.astro",
      "src/pages/register.astro"
    ],
    recordedOn: "2026-11-14",
    lastReview: null,
    maxAgeDays: 150,
    owner: "maintainer",
    note: "A security control: a silent change to the verification response would fail open or closed on every login."
  },
  {
    id: "github-rest",
    hosts: ["api.github.com"],
    provider: "GitHub REST API",
    surface: "Repository progress poller (read-only, opt-in per tenant)",
    status: "active",
    usedVersion: "REST, `X-GitHub-Api-Version: 2022-11-28`",
    changelogUrl:
      "https://docs.github.com/en/rest/about-the-rest-api/api-versions",
    pins: [
      {
        file: "src/modules/omes-control/application/repository-progress-poller.ts",
        literal: '"X-GitHub-Api-Version": "2022-11-28"'
      },
      {
        file: "src/modules/omes-control/application/repository-progress-poller.ts",
        literal: 'GITHUB_API_BASE = "https://api.github.com"'
      }
    ],
    files: [
      "src/modules/omes-control/application/repository-progress-poller.ts",
      "src/modules/omes-control/module.ts"
    ],
    recordedOn: "2026-11-14",
    lastReview: null,
    maxAgeDays: 150,
    owner: "maintainer",
    note: "GitHub supports an old API version for at least 24 months after a new one; the review is whether 2022-11-28 is still listed as supported."
  },
  {
    id: "tiktok-content-posting",
    hosts: ["open.tiktokapis.com", "business-api.tiktok.com"],
    provider: "TikTok",
    surface: "Content Posting API (social publishing connector)",
    status: "planned",
    usedVersion: "none: no TikTok connector exists in `src/` yet",
    changelogUrl:
      "https://developers.tiktok.com/doc/content-posting-api-get-started",
    pins: [],
    files: [],
    recordedOn: "2026-11-14",
    lastReview: null,
    maxAgeDays: 90,
    owner: "maintainer",
    note: "Planned entry. When a connector lands, flip this to `active`, add its files and pins, and perform the first changelog review in the same PR; the gate fails if a TikTok host appears in source while the entry is `planned`."
  },
  // awcms-one: the `commerce` module's own provider adapters. Rows beside
  // upstream's, never edited by it; keep them on conflict.
  {
    id: "commerce-meta-whatsapp",
    hosts: ["graph.facebook.com"],
    provider: "Meta WhatsApp Business Cloud API (commerce legacy-mode sender)",
    surface:
      "Message send (`/{phone-number-id}/messages`) by commerce's own legacy-mode adapter",
    status: "active",
    usedVersion: "Graph API v20.0 (the adapter's default base URL)",
    changelogUrl:
      "https://developers.facebook.com/docs/whatsapp/cloud-api/changelog",
    pins: [
      {
        file: "src/modules/commerce/infrastructure/meta-whatsapp-provider.ts",
        literal: 'DEFAULT_BASE_URL = "https://graph.facebook.com/v20.0"'
      }
    ],
    files: ["src/modules/commerce/infrastructure/meta-whatsapp-provider.ts"],
    recordedOn: "2026-11-18",
    lastReview: null,
    maxAgeDays: 90,
    owner: "maintainer",
    note: "A separate pin from `meta-whatsapp-cloud` (v21.0): commerce's legacy-mode adapter has its own base URL. Retired with the legacy mode once every tenant runs in `upstream` mode (ADR-0047)."
  },
  {
    id: "commerce-fonnte-whatsapp",
    hosts: ["api.fonnte.com"],
    provider: "Fonnte (commerce legacy-mode sender)",
    surface: "WhatsApp send by commerce's own legacy-mode adapter",
    status: "active",
    usedVersion: "Unversioned HTTP API (default base URL)",
    changelogUrl: "https://docs.fonnte.com/",
    pins: [
      {
        file: "src/modules/commerce/infrastructure/fonnte-provider.ts",
        literal: 'DEFAULT_BASE_URL = "https://api.fonnte.com"'
      }
    ],
    files: ["src/modules/commerce/infrastructure/fonnte-provider.ts"],
    recordedOn: "2026-11-18",
    lastReview: null,
    maxAgeDays: 90,
    owner: "maintainer",
    note: "Unofficial gateway with no dated changelog; compare its docs with the adapter at each review. Retired with the legacy mode (ADR-0047)."
  },
  {
    id: "commerce-midtrans",
    hosts: [
      "app.midtrans.com",
      "app.sandbox.midtrans.com",
      "api.midtrans.com",
      "api.sandbox.midtrans.com"
    ],
    provider: "Midtrans",
    surface:
      "Payment gateway: Snap session creation and transaction status (commerce payment-gateway adapter)",
    status: "active",
    usedVersion: "Snap and Core API v2 status (production and sandbox hosts)",
    changelogUrl: "https://docs.midtrans.com/",
    pins: [
      {
        file: "src/modules/commerce/infrastructure/midtrans-provider.ts",
        literal: 'SNAP_BASE_URL_PRODUCTION = "https://app.midtrans.com"'
      },
      {
        file: "src/modules/commerce/infrastructure/midtrans-provider.ts",
        literal: 'STATUS_BASE_URL_PRODUCTION = "https://api.midtrans.com"'
      }
    ],
    files: ["src/modules/commerce/infrastructure/midtrans-provider.ts"],
    recordedOn: "2026-11-18",
    lastReview: null,
    maxAgeDays: 90,
    owner: "maintainer",
    note: "No dated general changelog was found on the docs site (the version-history page covers GoPay MiniApps only); at the first review the maintainer records where Midtrans announces Snap and Core API changes, and confirms the sandbox hosts still match."
  },
  {
    id: "commerce-rajaongkir",
    hosts: ["rajaongkir.komerce.id"],
    provider: "RajaOngkir (Komerce API v2)",
    surface:
      "Shipping cost and destination lookup (commerce shipping adapter, base `/api/v1`)",
    status: "active",
    usedVersion: "Komerce API v2, base path `/api/v1`",
    changelogUrl: "https://rajaongkir.komerce.id/",
    pins: [
      {
        file: "src/modules/commerce/infrastructure/rajaongkir-provider.ts",
        literal: 'DEFAULT_BASE_URL = "https://rajaongkir.komerce.id/api/v1"'
      }
    ],
    files: ["src/modules/commerce/infrastructure/rajaongkir-provider.ts"],
    recordedOn: "2026-11-18",
    lastReview: null,
    maxAgeDays: 120,
    owner: "maintainer",
    note: "No API changelog page was found from the site root; at the first review the maintainer records where Komerce announces API changes (the site root is a placeholder, not a changelog)."
  }
];
