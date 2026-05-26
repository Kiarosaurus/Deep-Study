// LRU page-canvas cache backed by a pdfjs document.
//
// Owner passes a loaded PDFDocumentProxy (see use-pdf-document.js). This hook
// only manages the per-page render cache + queue — it does NOT load or destroy
// the doc itself, which lets a parent share one doc across multiple consumers
// (e.g. between paginated and linear views) without re-fetching on toggle.
//
// Consumers call `requestPage(pn)` which either touches LRU order (hit) or
// enqueues a render (miss). Renders run at most `concurrent` at a time. When
// cache exceeds `maxCached`, the least recently used canvas is dropped — that
// page reverts to undefined in the returned `pageCanvases` map, so downstream
// BlockCrops drop back to placeholder until re-requested.

import { useCallback, useEffect, useRef, useState } from 'react'

export const PDF_RENDER_SCALE =
  typeof window !== 'undefined'
    ? 2 * (window.devicePixelRatio || 1)
    : 2

export function usePageCache(pdfDoc, { maxCached = 8, concurrent = 2 } = {}) {
  const [pageCanvases, setPageCanvases] = useState({})

  const cacheRef      = useRef(new Map())   // pn → HTMLCanvasElement
  const lruOrder      = useRef([])           // MRU-first
  const pendingPages  = useRef(new Set())    // pages currently rendering or queued
  const renderQueue   = useRef([])
  const activeRenders = useRef(0)
  // Tracks the doc currently consumed. renderPage closures capture the doc
  // they started with; on resolve they compare against this ref and bail if
  // the parent has since swapped to a new doc.
  const currentDocRef = useRef(pdfDoc)
  currentDocRef.current = pdfDoc

  // Reset cache state when the underlying doc changes (e.g. file swap).
  // Note: we deliberately do NOT reset `activeRenders` — in-flight renders
  // from the old doc still need to decrement it in their `.finally`. Zeroing
  // it here would make the counter go negative as those finalize, briefly
  // allowing more than `concurrent` parallel renders on the new doc.
  useEffect(() => {
    return () => {
      const hadCanvases = cacheRef.current.size > 0
      cacheRef.current.clear()
      lruOrder.current = []
      pendingPages.current.clear()
      renderQueue.current = []
      if (hadCanvases) setPageCanvases({})
    }
  }, [pdfDoc])

  const publish = useCallback(() => {
    setPageCanvases(Object.fromEntries(cacheRef.current))
  }, [])

  const touch = useCallback((pn) => {
    lruOrder.current = [pn, ...lruOrder.current.filter(p => p !== pn)]
  }, [])

  const evictIfNeeded = useCallback(() => {
    let evicted = false
    while (lruOrder.current.length > maxCached) {
      const victim = lruOrder.current.pop()
      if (cacheRef.current.delete(victim)) evicted = true
    }
    if (evicted) publish()
  }, [maxCached, publish])

  const renderPage = useCallback(async (pn) => {
    const myDoc = pdfDoc
    if (!myDoc) return
    try {
      const page = await myDoc.getPage(pn)
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE })
      const canvas = document.createElement('canvas')
      canvas.width  = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const ctx = canvas.getContext('2d')
      await page.render({ canvasContext: ctx, viewport }).promise
      // Doc swapped while we were rendering — discard so we don't mix
      // canvases from two different documents in the same cache.
      if (currentDocRef.current !== myDoc) return
      cacheRef.current.set(pn, canvas)
      touch(pn)
      publish()
      evictIfNeeded()
    } catch (err) {
      console.warn(`usePageCache: render page ${pn} failed`, err)
    }
  }, [pdfDoc, touch, publish, evictIfNeeded])

  const processQueue = useCallback(function pq() {
    while (activeRenders.current < concurrent && renderQueue.current.length > 0) {
      const pn = renderQueue.current.shift()
      activeRenders.current++
      renderPage(pn).finally(() => {
        activeRenders.current--
        pendingPages.current.delete(pn)
        pq()
      })
    }
  }, [concurrent, renderPage])

  const requestPage = useCallback((pn) => {
    if (!pdfDoc) return
    if (cacheRef.current.has(pn)) {
      touch(pn)
      return
    }
    if (pendingPages.current.has(pn)) return
    pendingPages.current.add(pn)
    renderQueue.current.push(pn)
    processQueue()
  }, [pdfDoc, touch, processQueue])

  return { pageCanvases, requestPage }
}
