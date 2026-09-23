// Secrets are set with `wrangler secret put` (or .dev.vars locally), so `wrangler types`
// only sees them when .dev.vars exists. Declaring them here keeps type checks working without it.
interface Secrets {
  TYPESAFE_API_KEY: string;
  GROQ_API_KEY: string;
  OPENROUTER_API_KEY: string;
}

interface Env extends Secrets {}

declare namespace Cloudflare {
  interface Env extends Secrets {}
}
