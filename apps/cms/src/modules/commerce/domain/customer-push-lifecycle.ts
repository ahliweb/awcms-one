/**
 * `dataLifecycle` and `subjectData` descriptors for the four customer-push
 * tables (Issue #430, ADR-0048 section 2.3 and 3; `sql/1056`, `sql/1057`),
 * declared once here and spread into `module.ts`'s two arrays - the same shape
 * and reasoning as `segment-lifecycle.ts` and `booking-adapter-lifecycle.ts`.
 * Pure data.
 *
 * ## Retention (ADR-0048 Q8: 30 days, accepted as defaults)
 *
 * - `push_devices`: a device holds credentials ONLY while `active`; a revoked,
 *   gone or disabled row is a tombstone (hash + mask, no credential) kept 30 days
 *   after `revoked_at`, then purged. The cursor is `revoked_at`, which is NULL
 *   for an active device, so the age predicate can never match a live device.
 * - `push_messages` / `push_delivery_attempts`: terminal rows are purged 30 days
 *   after `updated_at` / `created_at`. A queued, sending or retry_wait row is
 *   work and is never purged however old (the predicate names the terminal
 *   statuses).
 * - `push_preferences`: kept while the account exists (the consent evidence of
 *   an account that is still there); removed with the account (`ON DELETE
 *   CASCADE`) or by the subject-erasure function. No age purge ever matches.
 *
 * All four are `delegated` to `commerce:customer-push:maintenance`
 * (`application/customer-push-maintenance.ts`): the generic age-only executor
 * would delete a message still `queued` behind a slow provider.
 *
 * ## Subject data - HONESTLY UNREACHABLE by the engine's vocabulary
 *
 * The endpoint URL is personal data under UU PDP 27/2022 (the design treats it as
 * such, ADR-0048 section 10) and a bearer-grade capability. But the subject of
 * these rows is a customer ACCOUNT, and a customer account carries no
 * `tenant_user` / `identity` / `profile` / `principal` id (ADR-0016 D1, the same
 * gap every other commerce customer table documents). The engine therefore
 * cannot find these rows from a subject id, and a `subjectColumns` entry naming
 * an id that is not there would be a fiction. Each descriptor is
 * `unreachableBySubject` and says where the erasure and the export REALLY live:
 *
 * - `eraseCustomerPushData` / `exportCustomerPushData`
 *   (`application/customer-push-erasure.ts`): keyed by the customer account,
 *   delete or list exactly these four tables. Any future account-deletion flow
 *   and any operator-assisted erasure call them.
 * - `ON DELETE CASCADE` from the account: deleting an account removes its
 *   devices, preferences and queued messages in the database, with no
 *   application step to forget.
 * - Self-service: a customer revokes one or all devices themselves at any time
 *   (`DELETE .../account/push/subscriptions`), which destroys the credentials
 *   immediately; blocking an account and logging out do the same.
 */
import type {
  HighVolumeTableDescriptor,
  SubjectDataDescriptor
} from "../../_shared/module-contract";
import { CUSTOMER_PUSH_RETENTION_DAYS } from "./customer-push";

const MAINTENANCE_COMMAND = "bun run commerce:customer-push:maintenance";
const MAINTENANCE_REF =
  "src/modules/commerce/application/customer-push-maintenance.ts#purgeCustomerPushForTenant";

const NO_ARCHIVE = {
  archivable: false,
  rationale:
    "The row is an operational delivery record (or a credential tombstone) with a 30-day half-life; archiving would copy a push endpoint's hash and mask, and a message's text, into a longer-lived artefact for no evidentiary value."
} as const;

const NO_LEGAL_HOLD = {
  applicable: false,
  precedence: "not_applicable"
} as const;

const BACKUP_NOTES =
  "Included in ordinary full-database backup/restore; no standalone archive artifact. Restore devices together with customer sessions; after a point-in-time restore treat every device as suspect (ADR-0048 section 9). Deploy the same PUSH_AUTH_SECRET_ENCRYPTION_KEYS ring that wrote the backup, or the credentials cannot be read.";

const WINDOW = {
  retentionClass: "communication_log",
  retentionMinDays: 7,
  retentionMaxDays: 365,
  defaultRetentionDays: CUSTOMER_PUSH_RETENTION_DAYS
} as const;

export const CUSTOMER_PUSH_DATA_LIFECYCLE: HighVolumeTableDescriptor[] = [
  {
    key: "commerce.push_devices",
    tableName: "awcms_commerce_push_devices",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "revoked_at",
    ...WINDOW,
    partition: {
      eligible: false,
      rationale:
        "At most five active devices per account; the table is bounded by the number of opted-in shoppers and never range-scanned for history."
    },
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "Only a non-active device (revoked, gone or disabled) past its tombstone window is eligible; an active device has a NULL revoked_at and can never match. Credentials are already destroyed on the status change, so the purge removes only a hash and a mask."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "status", "revoked_at"],
        purpose:
          "awcms_commerce_push_devices_status_revoked_idx (sql/1056) - the tombstone purge's own path."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "delegated",
    existingAdopter: {
      jobCommand: MAINTENANCE_COMMAND,
      purgeFunctionRef: MAINTENANCE_REF,
      description:
        "Deletes non-active devices whose revoked_at is older than the cutoff, in bounded batches, as awcms_worker (sql/1058); the same job first revokes the devices of ended customer sessions."
    }
  },
  {
    key: "commerce.push_preferences",
    tableName: "awcms_commerce_push_preferences",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "updated_at",
    retentionClass: "communication_log",
    retentionMinDays: 365,
    retentionMaxDays: 3650,
    defaultRetentionDays: 3650,
    partition: {
      eligible: false,
      rationale:
        "At most four rows (one per purpose) per account; bounded by the number of accounts."
    },
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "Consent evidence is kept while the account exists and removed with it (ON DELETE CASCADE) or by eraseCustomerPushData; no age-based purge is scheduled, so the executor never mutates this table."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "account_id"],
        purpose:
          "awcms_commerce_push_preferences_account_idx (sql/1056) - the per-account read and the erasure path."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "delegated",
    existingAdopter: {
      purgeFunctionRef:
        "src/modules/commerce/application/customer-push-erasure.ts#eraseCustomerPushData",
      description:
        "Removed with the customer account (FK cascade) or by eraseCustomerPushData; there is deliberately no scheduled age purge of consent evidence."
    }
  },
  {
    key: "commerce.push_messages",
    tableName: "awcms_commerce_push_messages",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "updated_at",
    ...WINDOW,
    partition: {
      eligible: false,
      rationale:
        "Bounded by the per-account notification cap (12 per hour, 40 per day) and drained continuously; the live set stays small."
    },
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "Only terminal rows (sent, failed, cancelled, expired) are eligible; queued, sending and retry_wait rows are pending work, not history, however old."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "status", "updated_at"],
        purpose:
          "awcms_commerce_push_messages_retention_idx (sql/1057) - the purge's own path."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "delegated",
    existingAdopter: {
      jobCommand: MAINTENANCE_COMMAND,
      purgeFunctionRef: MAINTENANCE_REF,
      description:
        "Deletes terminal messages older than the cutoff in bounded batches (their attempts cascade), as awcms_worker (sql/1058)."
    }
  },
  {
    key: "commerce.push_delivery_attempts",
    tableName: "awcms_commerce_push_delivery_attempts",
    ownerModuleKey: "commerce",
    scope: "tenant",
    cursorColumn: "created_at",
    ...WINDOW,
    partition: {
      eligible: false,
      rationale:
        "One row per provider attempt, a few per message, short retention; never range-scanned for history."
    },
    archive: NO_ARCHIVE,
    deletion: {
      mode: "hard_delete",
      rationale:
        "Append-only diagnostic rows with no status and no identifying column - the endpoint and the payload never appear here, only a fixed-vocabulary error and a capped, pre-redacted snippet."
    },
    legalHold: NO_LEGAL_HOLD,
    requiredIndexes: [
      {
        columns: ["tenant_id", "created_at"],
        purpose:
          "awcms_commerce_push_delivery_attempts_created_idx (sql/1057) - the purge's own ascending scan path."
      }
    ],
    batchLimit: 5000,
    backupRestoreNotes: BACKUP_NOTES,
    executionMode: "delegated",
    existingAdopter: {
      jobCommand: MAINTENANCE_COMMAND,
      purgeFunctionRef: MAINTENANCE_REF,
      description:
        "Deletes attempt rows older than the cutoff in bounded batches, as awcms_worker (sql/1058)."
    }
  }
];

const ERASURE_PATH =
  "eraseCustomerPushData / exportCustomerPushData (application/customer-push-erasure.ts), keyed by the customer account, and the account's ON DELETE CASCADE";

export const CUSTOMER_PUSH_SUBJECT_DATA: SubjectDataDescriptor[] = [
  {
    key: "commerce.push_devices",
    tableName: "awcms_commerce_push_devices",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #430 (ADR-0048) - a shopper's browser push subscription: the endpoint URL (personal data under UU PDP 27/2022 and a bearer-grade capability), its keys, a coarse browser description and timestamps. The subject is a customer ACCOUNT, which carries no tenant_user/identity/profile/principal id in this engine's subject vocabulary (ADR-0016 D1), so the engine cannot find these rows. They are NOT retained for an obligation: the real export and erasure are ${ERASURE_PATH}; a customer also revokes any or all devices themselves at any time, which destroys the credentials at once.`,
    redactedColumns: [
      "endpoint_ciphertext",
      "endpoint_hash",
      "p256dh_key",
      "auth_secret_ciphertext"
    ]
  },
  {
    key: "commerce.push_preferences",
    tableName: "awcms_commerce_push_preferences",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #430 (ADR-0048) - per account and purpose consent for push, with the consent text version and the grant/withdrawal times: evidence of a lawful basis, kept while the account exists. Keyed by a customer account id, which this engine's subject vocabulary cannot reach (ADR-0016 D1); the real export and erasure are ${ERASURE_PATH}.`
  },
  {
    key: "commerce.push_messages",
    tableName: "awcms_commerce_push_messages",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #430 (ADR-0048) - the outbox: generic template text and a fixed storefront path per event and device, never an order code, amount, name or phone (I6). Keyed by a customer account id this engine cannot reach (ADR-0016 D1); the real export and erasure are ${ERASURE_PATH}, and commerce:customer-push:maintenance purges terminal rows after 30 days.`
  },
  {
    key: "commerce.push_delivery_attempts",
    tableName: "awcms_commerce_push_delivery_attempts",
    ownerModuleKey: "commerce",
    unreachableBySubject: true,
    subjectColumns: [],
    exportable: false,
    erasure: "retain_under_obligation",
    rationale: `Issue #430 (ADR-0048) - one row per provider attempt: an outcome, a fixed-vocabulary error and a capped pre-redacted provider snippet. It names a message, never a person or an endpoint, so it is not personal data on its own; it goes with its message (FK cascade) and is purged after 30 days.`
  }
];
