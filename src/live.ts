/**
 * A setting that may be a plain value, or a function that gives the current one: the admin console can change some settings while
 * the bot runs (src/admin/settings.ts), so the code that uses them asks each time it needs the value instead of keeping the first.
 */
export type Live<T> = T | (() => T);

/** The current value of a `Live`. */
export function liveValue<T>(value: Live<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}
