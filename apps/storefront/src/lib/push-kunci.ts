/**
 * The two browser-storage keys of customer Web Push (issue #431) - alone in a
 * file with NO imports, so the code every account page loads (`push-sesi.ts`,
 * mounted from the header) can name the marker without dragging the build flag,
 * the worker path or the environment reader into an ordinary page's bundle.
 */

/** `localStorage` key of the enrolment marker: `{deviceId, accountId, at}`. NEVER the token, endpoint or keys. */
export const PUSH_MARKER_KEY = "awcms-one:push:v1";

/** `sessionStorage` key of a one-shot notice for the settings page (see `PemberitahuanPush`). */
export const PUSH_NOTICE_KEY = "awcms-one:push:notice:v1";
