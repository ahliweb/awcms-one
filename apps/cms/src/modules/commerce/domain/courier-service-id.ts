/**
 * The wire-level courier "service id" — Issue #107 (contract #106's D4).
 * Pure — no database, no I/O. A colon-separated `"<courier>:<service>"`
 * string (e.g. `"jne:REG"`) is what a storefront's shipping option/selection
 * and `POST .../orders`'s `shipping.serviceId` carry — one flat string
 * rather than two separate fields, so the client only ever needs to echo
 * back exactly what the quote handed it.
 */
export type CourierServiceId = { courier: string; service: string };

const SEPARATOR = ":";

export function formatCourierServiceId(
  courier: string,
  service: string
): string {
  return `${courier}${SEPARATOR}${service}`;
}

/**
 * `null` for anything that is not a non-empty `"<courier>:<service>"` pair —
 * a serviceId with no separator, an empty courier, or an empty service are
 * all equally invalid, never partially parsed.
 */
export function parseCourierServiceId(
  serviceId: string
): CourierServiceId | null {
  const separatorIndex = serviceId.indexOf(SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === serviceId.length - 1) {
    return null;
  }

  const courier = serviceId.slice(0, separatorIndex);
  const service = serviceId.slice(separatorIndex + 1);
  if (courier.length === 0 || service.length === 0) return null;

  return { courier, service };
}
