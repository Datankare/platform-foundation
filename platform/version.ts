/**
 * platform/version.ts — The platform-foundation release this code is
 *
 * Synced with the code, so a consumer always knows which platform release it carries — its own
 * package.json version is the app's, not the platform's. In platform-foundation it equals
 * package.json's version (checked by __tests__/docs-integrity.test.ts); bump both together.
 *
 * @module platform
 */

export const PLATFORM_VERSION = "5.1.0";
