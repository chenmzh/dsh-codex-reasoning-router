/**
 * Provider-published maximum output capabilities that are not currently
 * exposed by DSH's public exact-model metadata API.
 *
 * Keep these values aligned with pi-ai's installed provider catalog. Unknown
 * routes deliberately return undefined instead of guessing from context size.
 */
const BUILTIN_MAX_OUTPUT_TOKENS = new Map<string, number>([
  ['kimi-coding/k3', 131_072],
  ['kimi-coding/k3-256k', 131_072],
  ['kimi-coding/kimi-for-coding', 32_768],
  ['kimi-coding/kimi-for-coding-highspeed', 32_768],
])

export function builtinMaxOutputTokens(provider: string | undefined, model: string | undefined): number | undefined {
  if (provider === undefined || model === undefined) return undefined
  return BUILTIN_MAX_OUTPUT_TOKENS.get(`${provider}/${model}`)
}
