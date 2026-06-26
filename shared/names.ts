// shared/names.ts
// Friendly auto-generated peer names + validation.

export const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
export const NAME_MAX_LEN = 32;

const ADJECTIVES = [
  "calm","bold","swift","quiet","loud","bright","fuzzy","sly","brave","tidy",
  "glowy","snappy","mellow","nimble","sturdy","gentle","keen","plush","witty","chill",
  "zesty","peppy","breezy","sunny","dusky","sleek","lofty","spry","chirpy","merry",
  "cozy","crisp","jolly","dapper","suave","spunky","prim","proud","quirky","vivid",
  "zany","lush","balmy","hefty","burly","wispy","rosy","sage","brisk","lively"
];

const NOUNS = [
  "fox","panda","otter","hawk","whale","bison","koala","lynx","robin","heron",
  "moose","falcon","yak","seal","gecko","newt","finch","owl","badger","tiger",
  "wolf","crane","bat","crow","swan","lamb","mole","pony","shark","squid",
  "goose","eel","mantis","toad","cub","drake","stork","vole","wren","raven",
  "puma","zebu","llama","ibis","kiwi","quokka","tapir","dodo","civet","lemur"
];

export function generateName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
  return `${adj}-${noun}`;
}

// A single memorable word (animal noun) used to disambiguate a second+
// concurrent peer that wants a name already held by a live peer — e.g.
// `trophy-shopify-theme-codex` -> `trophy-shopify-theme-codex-otter`. One word
// (not adj-noun) keeps the disambiguated name short and readable.
export function generateSuffixWord(): string {
  return NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
}

// Append `-<word>` to `base`, trimming `base` from the right if needed so the
// result still fits within NAME_MAX_LEN (the suffix is always kept intact, and a
// dangling `-` left by trimming is removed). For normal repo names there is room
// and `base` is untouched; only a near-max base gets trimmed.
export function appendSuffixWithinLimit(base: string, word: string): string {
  const full = `${base}-${word}`;
  if (full.length <= NAME_MAX_LEN) return full;
  const allowed = NAME_MAX_LEN - word.length - 1; // 1 for the separator
  if (allowed <= 0) return word.slice(0, NAME_MAX_LEN);
  const trimmed = base.slice(0, allowed).replace(/-+$/, "") || "peer";
  return `${trimmed}-${word}`;
}

// Choose a peer name for `base` that does not collide with any LIVE peer name in
// `taken`. If `base` is free, return it unchanged — this preserves the clean
// canonical name (e.g. `<repo>-codex`) and the broker's reclaim-by-name path for
// the primary instance, so only a genuine concurrent duplicate is renamed. On a
// collision, append a funny word; if the picked words keep colliding, fall back
// to a deterministic numeric suffix. The broker's own suffix ladder remains the
// final backstop for the (rare) check-vs-register race, so this never needs to
// guarantee uniqueness on its own — it just makes the common case memorable.
export function pickAvailablePeerName(
  base: string,
  taken: Set<string>,
  opts?: { word?: () => string; attempts?: number },
): string {
  if (!taken.has(base)) return base;
  const word = opts?.word ?? generateSuffixWord;
  const attempts = opts?.attempts ?? 24;
  for (let i = 0; i < attempts; i++) {
    const candidate = appendSuffixWithinLimit(base, word());
    if (!taken.has(candidate)) return candidate;
  }
  for (let i = 2; i <= 99; i++) {
    const candidate = appendSuffixWithinLimit(base, String(i));
    if (!taken.has(candidate)) return candidate;
  }
  return base; // exhausted — let the broker's register-time ladder resolve it
}

export function isValidName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length < 1 || name.length > NAME_MAX_LEN) return false;
  return NAME_REGEX.test(name);
}
