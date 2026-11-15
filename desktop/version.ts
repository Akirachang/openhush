// Version comparison for updates (kept free of Electron imports so it can be unit-tested).

/** "v1.10.2-beta" -> [1, 10, 2]; anything after "-" is ignored. */
export function parseVersion(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
}

/** True when `candidate` is a higher version than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}
