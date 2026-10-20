/**
 * Composition root of the booking-commerce adapter's `BookingPort` (Issue #380,
 * ADR-0045 G2, cross-domain-contracts section 2): the one place that names
 * `booking`'s composed adapter on behalf of `commerce`.
 *
 * `commerce` depends on the NEUTRAL port type (`_shared/ports/booking-port.ts`)
 * and never imports `booking`'s code (a static test pins it); the port is
 * injected by the consumer's composition root - a ROUTE (which imports this
 * file) or a domain-event consumer (which loads it lazily, so a descriptor
 * stays import-light). Living in `src/lib/` keeps the edge out of both module
 * directories, where the boundary tests look.
 *
 * The composed port resolves the staff-availability constraint per tenant
 * exactly as Booking's own routes do, so a reservation made through the adapter
 * cannot double-book a person. It is stateless; one instance is reused.
 */
import type { BookingPort } from "../../modules/_shared/ports/booking-port";

let port: BookingPort | null = null;

/**
 * The composed port, built on first use. The `import()` is dynamic on purpose:
 * `booking/module.ts` sits in the module registry's import cycle
 * (`modules/index.ts` lists it), so a STATIC import here would make whichever
 * route or test happens to load this file first the entry point of that cycle
 * ("Cannot access 'bookingModule' before initialization"). By call time the
 * registry is loaded.
 */
export async function composedBookingPort(): Promise<BookingPort> {
  if (!port) {
    const { createComposedBookingPort } =
      await import("../../modules/booking/module");
    port = createComposedBookingPort();
  }
  return port;
}
