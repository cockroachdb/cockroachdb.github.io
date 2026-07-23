// The cross-block runtime wire. In the original single-file report these were bare
// `window.__*` globals set by the bootstrap and read by the chart/core. During the
// faithful port we keep that wire intact (typed `any`) so the ported chart/bootstrap
// code compiles verbatim; converting these into explicit module imports + a typed
// render context is a possible follow-up.
export {};

declare global {
  interface Window {
    /** The rendered arm catalog (1–2 arms), kept for copy-link round-trip. */
    __ARMS__: any;
    /** function(): base64url arms slug | null — external copy-link API. */
    __ENCODE_ARMS__: any;
  }
}
