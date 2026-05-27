// Map a SentenceExplanation back to the paragraph's sentence indices,
// even when the LLM returns indices that disagree with the quote it cited.
// Tiered resolution: declared indices → literal quote search → fuzzy-window
// scoring on significant words → fall back to whatever indices were declared.

const STOP_WORDS = new Set([
  'de','del','la','el','los','las','en','a','y','o','u','e','un','una','unos','unas',
  'que','se','con','por','para','su','sus','al','es','son','lo','le','les','si',
  'como','más','pero','este','esta','estos','estas','ese','esa','esos','esas',
  'the','an','of','in','to','and','or','for','with','is','are','at','by','on',
  'its','be','has','was','were','it','this','that','from','as',
])

export function significantWords(text) {
  if (!text) return []
  return [...new Set(
    text.toLowerCase()
      .replace(/[^\wáéíóúüñ\s]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  )]
}

export function charRangeToSentenceIndices(sentences, charStart, charEnd) {
  const indices = []
  let cursor = 0
  for (let i = 0; i < sentences.length; i++) {
    const len = sentences[i].text.length
    const sentEnd = cursor + len
    if (sentEnd > charStart && cursor < charEnd) indices.push(i)
    cursor = sentEnd + 1
  }
  return indices
}

export function indicesAgreeWithQuote(sentences, indices, quote) {
  if (!indices.length || !quote) return false
  const indexedLower = indices.map(i => sentences[i].text).join(' ').toLowerCase()
  if (indexedLower.includes(quote.toLowerCase())) return true
  const words = significantWords(quote)
  if (!words.length) return false
  const hits = words.filter(w => indexedLower.includes(w)).length
  return hits / words.length >= 0.7
}

export function resolveSentenceIndices(sentences, item) {
  if (!sentences?.length || !item) return []
  const { quote, sentence_indices: raw, concepts } = item

  const cleanIndices = Array.isArray(raw)
    ? raw.filter(i => Number.isInteger(i) && i >= 0 && i < sentences.length)
    : []

  // Tier 1
  if (indicesAgreeWithQuote(sentences, cleanIndices, quote)) return cleanIndices

  // Tier 2
  if (quote) {
    let concat = ''
    for (let i = 0; i < sentences.length; i++) {
      concat += sentences[i].text
      if (i < sentences.length - 1) concat += ' '
    }
    const idx = concat.toLowerCase().indexOf(quote.toLowerCase())
    if (idx !== -1) {
      const located = charRangeToSentenceIndices(sentences, idx, idx + quote.length)
      if (located.length) return located
    }
  }

  // Tier 3 — fuzzy sobre quote o concatenación de terms
  const conceptTerms = Array.isArray(concepts) ? concepts.map(c => c.term).join(' ') : ''
  const fuzzySource = quote || conceptTerms || ''
  const sigWords = significantWords(fuzzySource)
  if (sigWords.length) {
    const sentLowers = sentences.map(s => s.text.toLowerCase())
    const threshold  = Math.ceil(sigWords.length * 0.6)
    let bestStart = -1, bestEnd = -1, bestHits = 0
    for (let s = 0; s < sentences.length; s++) {
      const seen = new Set()
      for (let e = s; e < sentences.length && e - s < 5; e++) {
        for (const w of sigWords) if (sentLowers[e].includes(w)) seen.add(w)
        if (seen.size >= threshold && seen.size > bestHits) {
          bestHits  = seen.size
          bestStart = s
          bestEnd   = e
        }
      }
    }
    if (bestStart !== -1) {
      return Array.from({ length: bestEnd - bestStart + 1 }, (_, k) => bestStart + k)
    }
  }

  // Tier 4
  return cleanIndices
}


// Groups paragraph blocks into continuation chains. Walks `blocks` left-to-
// right; for each block with role==='paragraph', if continuation===true and a
// chain is already open, append to it; otherwise close the previous chain
// (flush merged payload) and open a new one with this block as head. Non-
// paragraph blocks (caption, equation, figure, table, code, list, section_
// header, title, author) are TRANSPARENT — they neither break nor extend the
// chain. This mirrors the post-pass bridging in `_merge_continuations_linear`
// / `_merge_continuations_pages` so the frontend chain reflects the same set
// of merges the backend marked with `continuation=True`.
//
// Returns an array same length as `blocks`. Each entry is either:
//   - null (non-paragraph block), or
//   - { text, sentences, offset } where text/sentences are the MERGED chain
//     payload (every block in the chain shares the same reference) and offset
//     is how many sentences from earlier chain members precede this block —
//     used at render time to translate merged-array indices back into this
//     block's own sentence array for per-block highlighting.
export function buildContinuationPayloads(blocks) {
  const out = new Array(blocks.length).fill(null)
  let chainIdxs = []

  const flush = () => {
    if (chainIdxs.length === 0) return
    if (chainIdxs.length === 1) {
      const b = blocks[chainIdxs[0]]
      out[chainIdxs[0]] = { text: b.text ?? '', sentences: b.sentences ?? [], offset: 0 }
    } else {
      const head = blocks[chainIdxs[0]]
      let text = head.text ?? ''
      const sentences = [...(head.sentences ?? [])]
      const offsets = [0]
      for (let k = 1; k < chainIdxs.length; k++) {
        offsets.push(sentences.length)
        const t   = text.replace(/\s+$/, '')
        const nxt = (blocks[chainIdxs[k]].text ?? '').replace(/^\s+/, '')
        text = /[-—¬]$/.test(t) ? t.slice(0, -1) + nxt : t + ' ' + nxt
        sentences.push(...(blocks[chainIdxs[k]].sentences ?? []))
      }
      for (let k = 0; k < chainIdxs.length; k++) {
        out[chainIdxs[k]] = { text, sentences, offset: offsets[k] }
      }
    }
    chainIdxs = []
  }

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b?.role !== 'paragraph') continue
    if (b.continuation && chainIdxs.length > 0) {
      chainIdxs.push(i)
    } else {
      flush()
      chainIdxs = [i]
    }
  }
  flush()
  return out
}
