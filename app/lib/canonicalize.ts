// Canonicalizzazione del body per la firma delle richieste.
// DEVE essere identica a server/src/middleware/auth.ts canonicalize().
// Modificare entrambe insieme. Test in server/src/routes/auth.test.ts verifica l'equivalenza.
// Zero dipendenze — importabile da Node.js nei test senza mock React Native.

function sortDeep(value: unknown): unknown {
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

export function canonicalize(
  method: string,
  urlPath: string,
  ts: number,
  pub: string,
  body: Record<string, unknown>,
): string {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k !== 'pub' && k !== 'ts' && k !== 'sig') filtered[k] = v;
  }
  return `${method}|${urlPath}|${ts}|${pub}|${JSON.stringify(sortDeep(filtered))}`;
}
