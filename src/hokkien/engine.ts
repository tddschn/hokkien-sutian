import { parseSyllable } from "./phonetics";
import type { DBAdapter, QueryResult, SqlValue } from "./db/types";
import type {
  EntrySynonym,
  Example,
  MeaningSynonym,
  PhoneticQuery,
  Result,
  ToneGroup,
} from "./types";

export type SearchMode =
  | "hokkien_entry"
  | "mandarin_example"
  | "hokkien_example"
  | "mandarin_fulltext"
  | "regex"
  | "hokkien_fulltext"
  | "category"
  | "multi_search"
  | "single_entry";

export type PhoneticIndex = {
  singleIndex: Map<string, Set<number>>;
  multiIndex: Map<string, Set<number>>;
  availableInitials: Set<string>;
  availableFinals: Set<string>;
  availableTones: Set<number>;
};

export type SearchExecutionResult = {
  results: Result[];
  truncated: boolean;
};

const emptyResult: QueryResult = { columns: [], values: [] };

const execSingle = (
  db: DBAdapter,
  sql: string,
  params?: Record<string, SqlValue>,
): QueryResult => db.exec(sql, params) ?? emptyResult;

const normalizeHanzi = (hanzi: string) => hanzi.replace(/【.*?】/g, "").trim();

const getReadingPriority = (hanziWithAnnotation: string): number => {
  if (
    hanziWithAnnotation.includes("【替】") ||
    hanziWithAnnotation.includes("【白】")
  )
    return 0;
  if (hanziWithAnnotation.includes("【文】")) return 2;
  return 1;
};

export const sortResults = (results: Result[], term: string): Result[] => {
  const normalizedTerm = term.trim();
  return [...results].sort((a, b) => {
    const aIsExact = normalizeHanzi(a.hanzi) === normalizedTerm;
    const bIsExact = normalizeHanzi(b.hanzi) === normalizedTerm;
    if (aIsExact !== bIsExact) return aIsExact ? -1 : 1;
    const aPrio = getReadingPriority(a.hanzi);
    const bPrio = getReadingPriority(b.hanzi);
    if (aPrio !== bPrio) return aPrio - bPrio;
    return a.id - b.id;
  });
};

export const registerRegexp = (db: DBAdapter) => {
  if (!db.createFunction) return false;
  try {
    db.createFunction("REGEXP", (pattern, value) => {
      if (typeof pattern !== "string" || typeof value !== "string") return 0;
      return new RegExp(pattern).test(value) ? 1 : 0;
    });
    return true;
  } catch {
    return false;
  }
};

const regexSearchFallback = (
  db: DBAdapter,
  pattern: string,
  maxResults?: number,
): { entryIds: Set<number>; truncated: boolean } => {
  const re = new RegExp(pattern);
  const entryIds = new Set<number>();
  let truncated = false;
  const result = execSingle(db, "SELECT id, hanzi FROM entries");
  result.values.forEach((row) => {
    if (maxResults && entryIds.size >= maxResults) {
      truncated = true;
      return;
    }
    const id = row[0] as number;
    const hanzi = row[1] as string;
    if (typeof hanzi !== "string") return;
    if (re.test(hanzi)) entryIds.add(id);
  });
  return { entryIds, truncated };
};

const execWithOptionalLimit = (
  db: DBAdapter,
  sql: string,
  params: Record<string, SqlValue>,
  maxResults: number | null,
): { queryResult: QueryResult; truncated: boolean } => {
  if (maxResults === null) {
    return {
      queryResult: execSingle(db, sql, params),
      truncated: false,
    };
  }

  if (db.execWithLimit) {
    const limited = db.execWithLimit(sql, params, maxResults);
    return {
      queryResult: limited.result,
      truncated: limited.hasMore,
    };
  }

  const limitPlusOneKey = "$__limit_plus_one";
  const plusOneResult = execSingle(db, `${sql} LIMIT ${limitPlusOneKey}`, {
    ...params,
    [limitPlusOneKey]: maxResults + 1,
  });
  const truncated = plusOneResult.values.length > maxResults;
  return {
    queryResult: {
      columns: plusOneResult.columns,
      values: truncated
        ? plusOneResult.values.slice(0, maxResults)
        : plusOneResult.values,
    },
    truncated,
  };
};

export const fetchEntryDetails = (
  db: DBAdapter,
  entryId: number,
): Result | null => {
  const entryRes = execSingle(
    db,
    "SELECT hanzi, romanization, category, audio_file FROM entries WHERE id = $id",
    { $id: entryId },
  );
  if (entryRes.values.length === 0) return null;

  const [hanzi, romanization, category, audio_file] = entryRes.values[0] as [
    string,
    string,
    string,
    string,
  ];

  const meanings = execSingle(
    db,
    "SELECT id, part_of_speech, explanation FROM meanings WHERE entry_id = $id",
    { $id: entryId },
  ).values.map((m, i) => ({
    id: m[0] as number,
    part_of_speech: m[1] as string,
    explanation: m[2] as string,
    display_id: i + 1,
    examples: [] as Example[],
  }));

  meanings.forEach((m) => {
    m.examples = execSingle(
      db,
      "SELECT hanzi, romanization, mandarin_translation FROM examples WHERE meaning_id = $id",
      { $id: m.id },
    ).values.map((ex) => ({
      hanzi: ex[0] as string,
      romanization: ex[1] as string,
      mandarin_translation: ex[2] as string,
    }));
  });

  const phoneticRes = execSingle(
    db,
    "SELECT * FROM phonetic_differences WHERE entry_id = $id",
    { $id: entryId },
  );

  const entrySynonyms = execSingle(
    db,
    "SELECT synonym_id, synonym_hanzi FROM entry_synonyms WHERE entry_id = $id",
    { $id: entryId },
  ).values.map((s) => ({
    id: s[0] as number,
    hanzi: s[1] as string,
  })) as EntrySynonym[];

  const meaningSynonymsMap = new Map<number, MeaningSynonym[]>();
  meanings.forEach((m) => {
    const synonyms = execSingle(
      db,
      "SELECT ms.synonym_meaning_id, ms.synonym_hanzi, ms.synonym_explanation, m.entry_id FROM meaning_synonyms ms JOIN meanings m ON ms.synonym_meaning_id = m.id WHERE ms.meaning_id = $id",
      { $id: m.id },
    ).values.map((s) => ({
      meaningId: s[0] as number,
      hanzi: s[1] as string,
      explanation: s[2] as string,
      entryId: s[3] as number,
    })) as MeaningSynonym[];
    if (synonyms.length > 0) {
      meaningSynonymsMap.set(m.id, synonyms);
    }
  });

  return {
    id: entryId,
    hanzi,
    romanization,
    category,
    audio_file,
    meanings,
    variant_characters: execSingle(
      db,
      "SELECT variant_hanzi FROM variant_characters WHERE entry_id = $id",
      { $id: entryId },
    ).values.flat() as string[],
    alternative_pronunciations: execSingle(
      db,
      "SELECT entry_id, hanzi, romanization FROM alternative_pronunciations WHERE entry_id = $id",
      { $id: entryId },
    ).values.map((p) => ({
      id: p[0] as number,
      hanzi: p[1] as string,
      romanization: p[2] as string,
    })),
    phonetic_differences:
      phoneticRes.values.length > 0
        ? phoneticRes.columns.reduce(
            (obj, col, i) => ({ ...obj, [col]: phoneticRes.values[0][i] }),
            {} as Record<string, SqlValue>,
          )
        : null,
    entry_synonyms: entrySynonyms,
    meaning_synonyms: meaningSynonymsMap,
  };
};

export const performSearchWithMeta = (
  db: DBAdapter,
  term: string,
  mode: SearchMode,
  options?: {
    maxResults?: number;
  },
): SearchExecutionResult => {
  if (!term.trim()) return { results: [], truncated: false };

  const rawMaxResults = options?.maxResults;
  const maxResults =
    typeof rawMaxResults === "number" &&
    Number.isFinite(rawMaxResults) &&
    rawMaxResults > 0
      ? Math.floor(rawMaxResults)
      : null;

  if (mode === "single_entry") {
    const entryId = parseInt(term.trim(), 10);
    if (Number.isNaN(entryId)) return { results: [], truncated: false };
    const result = fetchEntryDetails(db, entryId);
    return { results: result ? [result] : [], truncated: false };
  }

  if (mode === "multi_search") {
    const sentence = term.trim();
    const foundResults = new Map<
      string,
      { results: Result[]; termLength: number }
    >();

    for (let len = sentence.length; len >= 1; len--) {
      for (let i = 0; i <= sentence.length - len; i++) {
        const substring = sentence.substring(i, i + len);
        if (foundResults.has(substring)) continue;

        const matchedEntries: Result[] = [];
        const sql =
          "SELECT id, hanzi FROM entries WHERE hanzi = $term OR hanzi LIKE $term || '【%'";
        const params: Record<string, SqlValue> = { $term: substring };
        const matchRes = execSingle(
          db,
          maxResults === null ? sql : `${sql} LIMIT $limit`,
          maxResults === null ? params : { ...params, $limit: maxResults },
        );

        for (const row of matchRes.values) {
          const id = row[0] as number;
          const details = fetchEntryDetails(db, id);
          if (details) matchedEntries.push(details);
          if (maxResults !== null && matchedEntries.length >= maxResults) {
            break;
          }
        }

        if (matchedEntries.length > 0) {
          foundResults.set(substring, {
            results: sortResults(matchedEntries, substring),
            termLength: len,
          });
        }
      }
    }

    return {
      results: Array.from(foundResults.values())
        .sort((a, b) => b.termLength - a.termLength)
        .flatMap((item) => item.results),
      truncated: false,
    };
  }

  // The dictionary stores romanization in NFC; keyboard input may use combining marks.
  const trimmedTerm = term.trim().normalize("NFC");
  const likeTerm = `%${trimmedTerm}%`;
  const queries: Record<SearchMode, string> = {
    hokkien_entry:
      "SELECT id FROM entries WHERE hanzi LIKE $term OR romanization LIKE $term",
    mandarin_example:
      "SELECT DISTINCT e.id FROM entries e JOIN examples ex ON ex.entry_id = e.id WHERE ex.mandarin_translation LIKE $term",
    hokkien_example:
      "SELECT DISTINCT e.id FROM entries e JOIN examples ex ON ex.entry_id = e.id WHERE ex.hanzi LIKE $term OR ex.romanization LIKE $term",
    mandarin_fulltext:
      "SELECT id FROM entries WHERE hanzi LIKE $term UNION SELECT entry_id FROM meanings WHERE explanation LIKE $term UNION SELECT entry_id FROM examples WHERE mandarin_translation LIKE $term",
    regex: "SELECT id FROM entries WHERE hanzi REGEXP $term",
    hokkien_fulltext:
      "SELECT id FROM entries WHERE hanzi LIKE $term OR romanization LIKE $term UNION SELECT e.id FROM entries e JOIN examples ex ON ex.entry_id = e.id WHERE ex.hanzi LIKE $term OR ex.romanization LIKE $term",
    category: "SELECT id FROM entries WHERE category LIKE $term",
    multi_search: "",
    single_entry: "",
  };

  const query = queries[mode];
  if (!query) return { results: [], truncated: false };

  let truncated = false;
  const orderedEntryIds: number[] = [];

  const pushOrderedEntryId = (value: unknown) => {
    const id = value as number;
    if (!Number.isFinite(id)) return;
    orderedEntryIds.push(id);
  };

  const mfRankedQuery =
    "WITH matched AS (" +
    " SELECT id AS entry_id, CASE WHEN hanzi = $exactTerm THEN 0 WHEN hanzi LIKE $term THEN 4 ELSE 5 END AS rank FROM entries WHERE hanzi LIKE $term" +
    " UNION ALL" +
    " SELECT entry_id, CASE WHEN TRIM(explanation) = $exactTerm THEN 0 WHEN explanation LIKE $prefixTerm THEN 1 ELSE 2 END AS rank FROM meanings WHERE explanation LIKE $term" +
    " UNION ALL" +
    " SELECT entry_id, CASE WHEN TRIM(mandarin_translation) = $exactTerm THEN 0 WHEN mandarin_translation LIKE $prefixTerm THEN 1 ELSE 2 END AS rank FROM examples WHERE mandarin_translation LIKE $term" +
    " ), ranked AS (" +
    " SELECT entry_id, MIN(rank) AS best_rank FROM matched GROUP BY entry_id" +
    " )" +
    " SELECT ranked.entry_id FROM ranked JOIN entries e ON e.id = ranked.entry_id ORDER BY best_rank ASC, ranked.entry_id ASC";

  if (mode === "regex") {
    const params: Record<string, SqlValue> = { $term: trimmedTerm };
    try {
      const searchResult = execWithOptionalLimit(db, query, params, maxResults);
      truncated = searchResult.truncated;
      searchResult.queryResult.values.forEach((row) => {
        pushOrderedEntryId(row[0]);
      });
    } catch {
      // For runtimes that can't register SQL functions (e.g., bun:sqlite 1.3.x),
      // fall back to JS filtering.
      const fallback = regexSearchFallback(
        db,
        trimmedTerm,
        maxResults ?? undefined,
      );
      const fallbackResults = sortResults(
        Array.from(fallback.entryIds)
          .map((id) => fetchEntryDetails(db, id))
          .filter(Boolean) as Result[],
        trimmedTerm,
      );
      return { results: fallbackResults, truncated: fallback.truncated };
    }
  } else if (mode === "mandarin_fulltext") {
    const params: Record<string, SqlValue> = {
      $term: likeTerm,
      $exactTerm: trimmedTerm,
      $prefixTerm: `${trimmedTerm}%`,
    };
    const searchResult = execWithOptionalLimit(
      db,
      mfRankedQuery,
      params,
      maxResults,
    );
    truncated = searchResult.truncated;
    searchResult.queryResult.values.forEach((row) => {
      pushOrderedEntryId(row[0]);
    });
  } else {
    const params: Record<string, SqlValue> = { $term: likeTerm };
    const searchResult = execWithOptionalLimit(db, query, params, maxResults);
    truncated = searchResult.truncated;
    searchResult.queryResult.values.forEach((row) => {
      pushOrderedEntryId(row[0]);
    });
  }

  const dedupedOrderedEntryIds = Array.from(new Set(orderedEntryIds));

  const detailedResults = dedupedOrderedEntryIds
    .map((id) => fetchEntryDetails(db, id))
    .filter(Boolean) as Result[];

  const effectiveTruncated =
    truncated &&
    maxResults !== null &&
    Number.isFinite(maxResults) &&
    detailedResults.length >= maxResults;

  if (mode === "mandarin_fulltext") {
    return {
      results: detailedResults,
      truncated: effectiveTruncated,
    };
  }

  return {
    results: sortResults(detailedResults, trimmedTerm),
    truncated: effectiveTruncated,
  };
};

export const performSearch = (
  db: DBAdapter,
  term: string,
  mode: SearchMode,
  options?: {
    maxResults?: number;
  },
): Result[] => {
  return performSearchWithMeta(db, term, mode, options).results;
};

export const fetchRandomEntry = (db: DBAdapter): Result | null => {
  const randomRes = execSingle(
    db,
    "SELECT id FROM entries ORDER BY RANDOM() LIMIT 1",
  );
  if (randomRes.values.length === 0) return null;
  const randomId = randomRes.values[0][0] as number;
  return fetchEntryDetails(db, randomId);
};

export const fetchCategories = (db: DBAdapter): string[] => {
  const catRes = execSingle(
    db,
    "SELECT DISTINCT category FROM entries WHERE category IS NOT NULL AND category != ''",
  );
  const allCats = new Set<string>();
  catRes.values.forEach((row) => {
    const category = row[0] as string;
    if (!category) return;
    category.split(",").forEach((cat) => allCats.add(cat.trim()));
  });
  return Array.from(allCats).sort();
};

export const performPhoneticSearch = (
  db: DBAdapter,
  query: PhoneticQuery,
): { results: Result[]; toneGroups: ToneGroup[] } => {
  const toneToEntries = new Map<number, Map<string, Set<number>>>();
  const result = execSingle(db, "SELECT id, romanization FROM entries");

  result.values.forEach((row) => {
    const id = row[0] as number;
    const romanization = row[1] as string;
    if (!romanization) return;

    const pronunciationVariants = romanization.split("/");
    pronunciationVariants.forEach((variant) => {
      const syllables = variant.split(/[-\s]+/).filter((s) => s.trim());
      if (query.singleSyllableOnly && syllables.length > 1) return;

      syllables.forEach((syl) => {
        const { initial, final, tone } = parseSyllable(syl);
        if (!final) return;

        const entryInitial = initial || "ling";
        const matchesInitial =
          query.initial === null || entryInitial === query.initial;
        const matchesFinal = query.final === null || final === query.final;
        const matchesTone = query.tone === null || tone === query.tone;

        if (matchesInitial && matchesFinal && matchesTone) {
          if (!toneToEntries.has(tone)) {
            toneToEntries.set(tone, new Map());
          }
          const syllableMap = toneToEntries.get(tone)!;
          const normalizedSyl = syl.trim();
          if (!syllableMap.has(normalizedSyl)) {
            syllableMap.set(normalizedSyl, new Set());
          }
          syllableMap.get(normalizedSyl)!.add(id);
        }
      });
    });
  });

  const groups: ToneGroup[] = [];
  const allEntryIds = new Set<number>();
  const sortedTones = Array.from(toneToEntries.keys()).sort((a, b) => a - b);

  sortedTones.forEach((tone) => {
    const syllableMap = toneToEntries.get(tone)!;
    const toneEntryIds = new Set<number>();
    let representativeSyllable = "";

    for (const [syl, ids] of syllableMap) {
      if (!representativeSyllable) representativeSyllable = syl;
      ids.forEach((entryId) => {
        toneEntryIds.add(entryId);
        allEntryIds.add(entryId);
      });
    }

    const entries = Array.from(toneEntryIds)
      .map((entryId) => fetchEntryDetails(db, entryId))
      .filter(Boolean) as Result[];

    if (entries.length > 0) {
      groups.push({
        tone,
        syllable: representativeSyllable,
        entries: sortResults(entries, ""),
      });
    }
  });

  const allResults = Array.from(allEntryIds)
    .map((entryId) => fetchEntryDetails(db, entryId))
    .filter(Boolean) as Result[];

  return {
    results: sortResults(allResults, ""),
    toneGroups: groups,
  };
};

export const buildPhoneticIndex = (db: DBAdapter): PhoneticIndex => {
  const singleIndex = new Map<string, Set<number>>();
  const multiIndex = new Map<string, Set<number>>();
  const allInitials = new Set<string>();
  const allFinals = new Set<string>();
  const allTones = new Set<number>();

  const result = execSingle(db, "SELECT id, romanization FROM entries");
  result.values.forEach((row) => {
    const id = row[0] as number;
    const romanization = row[1] as string;
    if (!romanization) return;

    const pronunciationVariants = romanization.split("/");
    pronunciationVariants.forEach((variant) => {
      const syllables = variant.split(/[-\s]+/).filter((s) => s.trim());
      const isSingleSyllable = syllables.length === 1;

      syllables.forEach((syl) => {
        const { initial, final, tone } = parseSyllable(syl);
        if (!final) return;

        const key = `${initial || "ling"}|${final}|${tone}`;

        if (isSingleSyllable) {
          if (!singleIndex.has(key)) singleIndex.set(key, new Set());
          singleIndex.get(key)!.add(id);
        } else {
          if (!multiIndex.has(key)) multiIndex.set(key, new Set());
          multiIndex.get(key)!.add(id);
        }

        allInitials.add(initial || "ling");
        allFinals.add(final);
        allTones.add(tone);
      });
    });
  });

  return {
    singleIndex,
    multiIndex,
    availableInitials: allInitials,
    availableFinals: allFinals,
    availableTones: allTones,
  };
};
