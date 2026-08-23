export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Substitute {accountId} style placeholders in a base URL. */
export function renderBaseUrl(baseUrl: string, vars: Record<string, string | undefined>): string {
  return baseUrl.replace(/\{(\w+)\}/g, (full, key: string) => vars[key] ?? full);
}
