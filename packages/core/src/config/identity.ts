/**
 * 🏷️ WHITE-LABEL CONFIG (RaidOS core)
 * The same installation becomes $SAUR, $PEPE or $XYZ by changing config only.
 * No project identity is hardcoded anywhere in core.
 */

export interface ProjectIdentity {
  projectName: string;
  tokenSymbol: string;
  tokenAddress?: string;
  logoUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  telegram?: string;
  twitter?: string;
  website?: string;
  lore?: string;
  faq?: { q: string; a: string }[];
  rules?: string[];
}

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export function loadIdentity(): ProjectIdentity {
  const faqRaw = env("FAQ"); // "Q1|A1;;Q2|A2"
  const rulesRaw = env("RULES"); // "rule1;;rule2"
  return {
    projectName: env("PROJECT_NAME", "RaidOS Community"),
    tokenSymbol: env("TOKEN_SYMBOL", "COMMUNITY"),
    tokenAddress: env("TOKEN_ADDRESS") || undefined,
    logoUrl: env("LOGO_URL") || undefined,
    primaryColor: env("PRIMARY_COLOR", "#7C3AED"),
    secondaryColor: env("SECONDARY_COLOR", "#22D3EE"),
    telegram: env("TELEGRAM") || undefined,
    twitter: env("TWITTER") || undefined,
    website: env("WEBSITE") || undefined,
    lore: env("LORE") || undefined,
    faq: faqRaw
      ? faqRaw.split(";;").map((pair) => {
          const [q, ...rest] = pair.split("|");
          return { q: (q ?? "").trim(), a: rest.join("|").trim() };
        })
      : undefined,
    rules: rulesRaw ? rulesRaw.split(";;").map((r) => r.trim()) : undefined,
  };
}
