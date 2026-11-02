// Playwright is supplied by the environment (preinstalled locally, installed in CI); this shim keeps
// the typecheck independent of where it lives.
declare module 'playwright' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const chromium: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Page = any;
}
