---
bump: minor
type: content
impact: public
---

# Booking-derived CRM segment rules (rule schema 2)

Issue #390 (epic #280 item 7, second half), [ADR-0051](../docs/adr/0051-booking-derived-segment-rules-are-rule-schema-2-read-live-through-the-booking-links-and-never-stored.md). The segment rule vocabulary gains five conditions about a customer's bookings, as a new **rule schema version**, so that a store that sells stays can ask "who stayed and has not been back for a year", "who booked in the last 90 days", "who no-showed twice" without a second copy of anyone's booking history.

- New fields: `booking_count`, `stay_count`, `last_stay_date`, `no_show_count`, `cancellation_count` (a cancellation by staff is never counted against a customer). Same bounds, windows, small-group suppression and masking as every other field.
- Old rules keep evaluating unchanged: `sql/1060` adds `awcms_commerce_segment_versions.rule_schema_version` (default 1 = every existing version) and a stored version is always read under the schema it was written under; new versions are written under schema 2. The API shows `ruleSchemaVersion` on each version.
- Read live, never stored: the facts are aggregated at evaluation time from the booking links, their orders and the cancel / no-show decisions, joined to Booking's reservation status and arrival date (one new `SELECT`-only reader of a Booking table, two columns, pinned by a test). No new table, no new index, no event.
- Access: defining a rule that uses them needs the `booking` feature and `commerce.booking_reservation_links.read`; counting, listing, exporting, aiming a campaign or restricting a loyalty program at a saved one needs the permission.
- The segment screen offers the five conditions only to a viewer who may use them; its page script is 38 bytes smaller, so the client asset budget is unchanged.
- The M7 benchmark (`bun run bench:commerce-load --only segment`) now seeds booking links and decisions and measures ten rule shapes: preview p95 1.94 s on 100,000 customers, 340,000 orders and 90,000 booking links (target 3 s).
