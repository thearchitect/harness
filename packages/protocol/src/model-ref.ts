// Model references: `provider/<family | id>[:<thinking>]`. An exact id is taken as is; a family
// (`anthropic/opus`) resolves to the newest model of that family in the catalog. Pure and
// isomorphic: the agent and every UI resolve a reference the same way.

export type CatalogModel = { provider: string; id: string };

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingSuffix = (typeof THINKING_LEVELS)[number];

export type ParsedModelRef = { provider: string; name: string; thinking?: ThinkingSuffix };

export type ResolvedModelRef =
  | { ok: true; model: CatalogModel; thinking?: ThinkingSuffix; family: boolean }
  | { ok: false; error: "invalid" | "not_found" | "ambiguous"; message: string; candidates: CatalogModel[] };

export function parseModelRef(ref: string): ParsedModelRef | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return undefined;
  } else {
    const provider = ref.slice(0, slash);
    const rest = ref.slice(slash + 1);
    const colon = rest.lastIndexOf(":");
    if (colon === -1) {
      return { provider, name: rest };
    } else {
      const suffix = rest.slice(colon + 1);
      if ((THINKING_LEVELS as readonly string[]).includes(suffix) && colon > 0) {
        return { provider, name: rest.slice(0, colon), thinking: suffix as ThinkingSuffix };
      } else {
        return undefined;
      }
    }
  }
}

const DATED_SNAPSHOT = /-\d{8}$/;

function tokens(id: string): string[] {
  return id.toLowerCase().split(/[-./]/).filter((token) => token !== "");
}

function isNumeric(token: string): boolean {
  return /^\d+$/.test(token);
}

/** The version of an id: its numeric tokens in order ("claude-opus-5-5" → [5, 5]). */
export function versionOf(id: string): number[] {
  return tokens(id).filter(isNumeric).map(Number);
}

/** The family base of an id: its non-numeric tokens ("gpt-6.2-sol" → "gpt-sol"). */
function baseOf(id: string): string[] {
  return tokens(id).filter((token) => !isNumeric(token));
}

/** Compares numeric version tuples; a longer tuple with an equal prefix is newer ([5,5] > [5]). */
export function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) {
      return -1;
    } else if (right === undefined) {
      return 1;
    } else if (left !== right) {
      return left - right;
    } else {
      // equal at this position: compare the next one
    }
  }
  return 0;
}

export function resolveModelRef(ref: string, catalog: readonly CatalogModel[]): ResolvedModelRef {
  const parsed = parseModelRef(ref);
  if (parsed === undefined) {
    return { ok: false, error: "invalid", message: `not a model reference: "${ref}" (provider/<family|id>[:thinking])`, candidates: [] };
  }

  const ofProvider = catalog.filter((model) => model.provider === parsed.provider);
  const exact = ofProvider.find((model) => model.id === parsed.name);
  if (exact !== undefined) {
    return { ok: true, model: exact, thinking: parsed.thinking, family: false };
  }

  const family = parsed.name.toLowerCase();
  const candidates = ofProvider.filter((model) => tokens(model.id).includes(family) && !DATED_SNAPSHOT.test(model.id));
  if (candidates.length === 0) {
    return { ok: false, error: "not_found", message: `no model of family "${parsed.name}" at provider "${parsed.provider}"`, candidates: [] };
  }

  const groups = new Map<string, CatalogModel[]>();
  for (const model of candidates) {
    const key = baseOf(model.id).join("-");
    groups.set(key, [...(groups.get(key) ?? []), model]);
  }
  const shortest = Math.min(...[...groups.keys()].map((key) => key.split("-").length));
  const narrowest = [...groups.entries()].filter(([key]) => key.split("-").length === shortest);
  if (narrowest.length > 1) {
    return {
      ok: false,
      error: "ambiguous",
      message: `"${ref}" matches several families: ${narrowest.map(([key]) => key).join(", ")}`,
      candidates: narrowest.flatMap(([, models]) => models),
    };
  } else {
    const newest = [...narrowest[0][1]].sort((a, b) => compareVersions(versionOf(b.id), versionOf(a.id)))[0];
    return { ok: true, model: newest, thinking: parsed.thinking, family: true };
  }
}
