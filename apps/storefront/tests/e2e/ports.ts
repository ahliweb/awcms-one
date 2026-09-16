/**
 * The two ports this e2e run wires together — a plain constant, not
 * randomised: `global-setup.ts` needs the STUB's port before it runs the
 * BUILD (`PUBLIC_AWCMS_ORIGIN`/`AWCMS_API_URL` must point at it), and the
 * PREVIEW server's port before the stub starts (`STUB_ALLOWED_ORIGIN` — the
 * one `Origin` the stub's CORS check answers — must equal wherever the
 * built site is about to be served from). Fixed ports keep that ordering
 * simple; this suite is not designed to run multiple instances in parallel
 * on one host.
 */
export const STUB_PORT = Number(process.env.E2E_STUB_PORT ?? 4310);
export const PREVIEW_PORT = Number(process.env.E2E_PREVIEW_PORT ?? 4321);
