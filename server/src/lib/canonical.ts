export function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(obj: Record<string, unknown>): string {
  return JSON.stringify(sortDeep(obj));
}
