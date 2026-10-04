/**
 * Lets the queueing code ask for an availability pass without importing the
 * checker (which imports the queueing code). availability.ts registers the
 * real function when it loads; until then a kick is a no-op.
 */
let kick: (() => void) | null = null;

export function registerAvailabilityKick(fn: () => void): void {
  kick = fn;
}

export function kickAvailabilityChecks(): void {
  kick?.();
}
