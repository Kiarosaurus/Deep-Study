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
