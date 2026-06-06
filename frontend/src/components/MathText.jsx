/* eslint-disable react-refresh/only-export-components -- wrapBareLatex is a
   small helper co-located with its component; only affects HMR. */
import { Fragment, useMemo } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

// Render a string that may contain LaTeX math, mixing prose with KaTeX-rendered
// expressions. The AI explanation output wraps math in $…$ / $$…$$ (and we also
// accept \(…\) / \[…\]); everything else is plain text. Robust by design:
// unparseable math falls back to its raw source so nothing is ever lost.

// Delimiter pairs, longest-opener first so `$$` wins over `$`.
const DELIMS = [
  { open: '$$', close: '$$', display: true },
  { open: '\\[', close: '\\]', display: true },
  { open: '\\(', close: '\\)', display: false },
  { open: '$',  close: '$',  display: false },
]

function tokenize(text) {
  const tokens = []
  let buf = ''
  let i = 0
  while (i < text.length) {
    // Escaped dollar is a literal '$', never a delimiter.
    if (text[i] === '\\' && text[i + 1] === '$') { buf += '$'; i += 2; continue }
    let hit = null
    for (const d of DELIMS) {
      if (text.startsWith(d.open, i)) {
        const start = i + d.open.length
        const end = text.indexOf(d.close, start)
        if (end !== -1 && end > start) { hit = { d, start, end }; break }
      }
    }
    if (hit) {
      if (buf) { tokens.push({ type: 'text', value: buf }); buf = '' }
      tokens.push({ type: 'math', value: text.slice(hit.start, hit.end), display: hit.d.display })
      i = hit.end + hit.d.close.length
    } else {
      buf += text[i]; i += 1
    }
  }
  if (buf) tokens.push({ type: 'text', value: buf })
  return tokens
}

// A fragment that is bare LaTeX with no delimiters (e.g. a recognized display
// equation's quote) — wrap it as display math. Detected by a LaTeX control
// sequence (`\frac`, `\alpha`, `\begin`…), which prose never contains.
export function wrapBareLatex(s) {
  if (!s) return s
  if (/[$]|\\\(|\\\[/.test(s)) return s
  if (/\\[a-zA-Z]/.test(s)) return `$$${s}$$`
  return s
}

function Math({ tex, display }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore' })
    } catch {
      return null
    }
  }, [tex, display])
  if (html == null) return <span>{display ? `$$${tex}$$` : `$${tex}$`}</span>
  return (
    <span
      className={display ? 'block my-1' : ''}
      // KaTeX sanitizes its own output; input is our own AI/extraction text.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export default function MathText({ children, className }) {
  const text = typeof children === 'string' ? children : String(children ?? '')
  const tokens = useMemo(() => tokenize(text), [text])
  if (!tokens.some(t => t.type === 'math')) {
    return <span className={className}>{text}</span>
  }
  return (
    <span className={className}>
      {tokens.map((t, i) => (
        t.type === 'text'
          ? <Fragment key={i}>{t.value}</Fragment>
          : <Math key={i} tex={t.value} display={t.display} />
      ))}
    </span>
  )
}
