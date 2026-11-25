// pi-tui's fuzzy matching (dist/fuzzy.js of @earendil-works/pi-tui, MIT), carried here because the
// client is isomorphic and the app's bundle has no pi-tui: every query character in order, the
// best alignment scored (consecutive characters and word starts count), all tokens of a query
// matching. fuzzy.test.ts checks it against pi-tui's own on the same inputs.

export type FuzzyMatch = { matches: boolean; score: number };

function scorePositions(textLower: string, positions: number[]): number {
  let score = 0;
  let lastMatchIndex = -1;
  let consecutiveMatches = 0;
  for (const i of positions) {
    if (lastMatchIndex === i - 1) {
      consecutiveMatches += 1;
      score -= consecutiveMatches * 5;
    } else {
      consecutiveMatches = 0;
      if (lastMatchIndex >= 0) {
        score += (i - lastMatchIndex - 1) * 2;
      } else {
        // the first character: no gap before it
      }
    }
    if (i === 0 || /[\s\-_./:]/.test(textLower[i - 1] ?? "")) {
      score -= 10;
    } else {
      // inside a word
    }
    score += i * 0.1;
    lastMatchIndex = i;
  }
  return score;
}

function matchQuery(normalizedQuery: string, textLower: string): FuzzyMatch {
  if (normalizedQuery.length === 0) {
    return { matches: true, score: 0 };
  } else if (normalizedQuery.length > textLower.length) {
    return { matches: false, score: 0 };
  } else {
    // greedy: each query character at its first occurrence after the previous one
    const positions: number[] = [];
    let lastMatchIndex = -1;
    for (const character of normalizedQuery) {
      const i = textLower.indexOf(character, lastMatchIndex + 1);
      if (i === -1) {
        return { matches: false, score: 0 };
      } else {
        positions.push(i);
        lastMatchIndex = i;
      }
    }
    let score = scorePositions(textLower, positions);
    // every contiguous occurrence too: the greedy alignment may scatter over an unrelated part
    for (let start = textLower.indexOf(normalizedQuery); start !== -1; start = textLower.indexOf(normalizedQuery, start + 1)) {
      score = Math.min(
        score,
        scorePositions(
          textLower,
          positions.map((_, k) => start + k),
        ),
      );
    }
    return { matches: true, score: normalizedQuery === textLower ? score - 100 : score };
  }
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  const primary = matchQuery(queryLower, textLower);
  const alphaNumeric = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/.exec(queryLower);
  const numericAlpha = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/.exec(queryLower);
  const swapped = alphaNumeric
    ? `${alphaNumeric.groups?.digits ?? ""}${alphaNumeric.groups?.letters ?? ""}`
    : numericAlpha
      ? `${numericAlpha.groups?.letters ?? ""}${numericAlpha.groups?.digits ?? ""}`
      : "";
  if (primary.matches || swapped === "") {
    return primary;
  } else {
    const match = matchQuery(swapped, textLower);
    return match.matches ? { matches: true, score: match.score + 5 } : primary;
  }
}

/** The items whose text matches every token of the query (whitespace- or slash-separated), best first. */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
  const tokens = query
    .trim()
    .split(/[\s/]+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return items;
  } else {
    const results: { item: T; score: number }[] = [];
    for (const item of items) {
      const text = getText(item);
      const matches = tokens.map((token) => fuzzyMatch(token, text));
      if (matches.every((match) => match.matches)) {
        results.push({ item, score: matches.reduce((sum, match) => sum + match.score, 0) });
      } else {
        // a token does not match
      }
    }
    return results.sort((a, b) => a.score - b.score).map((result) => result.item);
  }
}
