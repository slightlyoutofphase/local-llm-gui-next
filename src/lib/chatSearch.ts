const FTS_RESERVED_KEYWORDS = new Set(["AND", "NOT", "OR"]);
const CHAT_SEARCH_TERM_PATTERN = /[\p{L}\p{N}_]+/gu;
const PUNCTUATION_PATTERN = /[^\p{L}\p{N}_\s]/u;
const SINGLE_LETTER_PATTERN = /^\p{L}$/u;

export const CHAT_SEARCH_DEBOUNCE_MS = 200;

/** Returns the trimmed chat-search query used across frontend and backend code paths. */
export function normalizeChatSearchQuery(query: string): string {
  return query.trim();
}

/**
 * Extracts safe full-text search terms from user-entered chat search text.
 *
 * For punctuation-heavy input such as `C++`, single-letter fragments are treated as punctuation
 * artifacts and dropped so the resulting query does not broaden unexpectedly.
 */
export function extractChatSearchTerms(query: string): string[] {
  const normalizedQuery = normalizeChatSearchQuery(query);
  const candidateTerms = normalizedQuery.match(CHAT_SEARCH_TERM_PATTERN) ?? [];
  const containsPunctuation = PUNCTUATION_PATTERN.test(normalizedQuery);
  const seenTerms = new Set<string>();

  return candidateTerms.filter((term) => {
    if (FTS_RESERVED_KEYWORDS.has(term.toUpperCase())) {
      return false;
    }

    if (containsPunctuation && term.length === 1 && SINGLE_LETTER_PATTERN.test(term)) {
      return false;
    }

    const dedupeKey = term.toLowerCase();

    if (seenTerms.has(dedupeKey)) {
      return false;
    }

    seenTerms.add(dedupeKey);
    return true;
  });
}

/** Returns whether a non-empty query still contains at least one meaningful search term. */
export function hasMeaningfulChatSearchTerms(query: string): boolean {
  return extractChatSearchTerms(query).length > 0;
}

/** Builds the SQLite FTS fragment used by backend chat search. */
export function buildChatSearchFtsQuery(query: string): string | null {
  const terms = extractChatSearchTerms(query);

  if (terms.length === 0) {
    return null;
  }

  return terms.map((term) => `"${term}"*`).join(" ");
}
