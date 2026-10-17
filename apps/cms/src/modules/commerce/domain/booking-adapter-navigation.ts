/**
 * Sidebar entries of the booking-commerce adapter (ADR-0045), declared once here
 * and spread into `module.ts`'s `navigation` array. EMPTY in Issue #378, which
 * lands the tables, the offering-link routes and the deposit-policy routes but
 * no screen: the admin screens arrive with the issues that own them (the
 * offering-link and policy screens, then the reservation and refund screens),
 * each appending its entry HERE rather than editing `module.ts`.
 */
import type { ModuleNavigationEntry } from "../../_shared/module-contract";

export const BOOKING_ADAPTER_NAVIGATION: ModuleNavigationEntry[] = [];
