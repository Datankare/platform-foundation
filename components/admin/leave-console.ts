/**
 * components/admin/leave-console.ts — leave the admin console with a full page load
 *
 * A full load, not client navigation: nothing the console held in memory survives it. Its own
 * module so a test can see where the console sends its user (jsdom's `location` cannot be
 * replaced).
 */
export function leaveConsole(path: string): void {
  window.location.assign(path);
}
