/**
 * Deterministic BM25 keyword retrieval with CJK support. Pure functions, no
 * dependencies, no model calls — recall works offline and is cache-safe.
 * @module
 */

/** Latin words and CJK unigram tokens. CJK text has no word boundaries, so
 * unigrams give usable exact-match recall for short queries (same choice as
 * the reference BM25 implementations in the DSH memory ecosystem). */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  // latin/digit words
  for (const word of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    tokens.push(word)
  }
  // CJK unigrams
  for (const ch of text) {
    if (isCjk(ch)) tokens.push(ch)
  }
  return tokens
}

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0)!
  return (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0x3000 && code <= 0x303f) // CJK punctuation
}

interface Doc {
  id: string
  text: string
  tokens: string[]
}

const K1 = 1.2
const B = 0.75

/** Incremental BM25 index over document ids and texts. */
export class Bm25Index {
  private docs = new Map<string, Doc>()
  private df = new Map<string, number>()
  private avgLen = 0

  /** Insert or replace one document. */
  upsert(id: string, text: string): void {
    const tokens = dedupe(tokenize(text))
    this.docs.set(id, { id, text, tokens })
    this.rebuildStats()
  }

  remove(id: string): void {
    this.docs.delete(id)
    this.rebuildStats()
  }

  /** Recompute document frequencies and average length after a change. */
  private rebuildStats(): void {
    this.df.clear()
    let totalLen = 0
    for (const doc of this.docs.values()) {
      totalLen += doc.tokens.length
      for (const token of new Set(doc.tokens)) {
        this.df.set(token, (this.df.get(token) ?? 0) + 1)
      }
    }
    this.avgLen = this.docs.size === 0 ? 0 : totalLen / this.docs.size
  }

  /** Score all documents against one query and return the top `topK`. */
  search(query: string, topK: number, filter?: (id: string) => boolean): Array<{ id: string; score: number }> {
    const queryTokens = dedupe(tokenize(query))
    if (queryTokens.length === 0 || this.docs.size === 0) return []
    const n = this.docs.size
    const results: Array<{ id: string; score: number }> = []
    for (const doc of this.docs.values()) {
      if (filter !== undefined && !filter(doc.id)) continue
      let score = 0
      const tokenCounts = new Map<string, number>()
      for (const token of doc.tokens) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1)
      for (const token of queryTokens) {
        const tf = tokenCounts.get(token) ?? 0
        if (tf === 0) continue
        const df = this.df.get(token) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        const denom = tf + K1 * (1 - B + B * (doc.tokens.length / (this.avgLen || 1)))
        score += idf * ((tf * (K1 + 1)) / denom)
      }
      if (score > 0) results.push({ id: doc.id, score })
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  get size(): number {
    return this.docs.size
  }
}

function dedupe(tokens: string[]): string[] {
  return [...new Set(tokens)]
}
