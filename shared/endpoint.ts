export function normalizeEndpoint(endpointUrl: string): string {
  return endpointUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1\/chat\/completions$/, '')
    .replace(/\/v1\/models$/, '')
    .replace(/\/v1$/, '');
}
