// LRU page-canvas cache backed by pdfjs.
//
// Mounts pdfjs document once per pdfFile. Consumers call `requestPage(pn)`
// which either touches LRU order (hit) or enqueues a render (miss). Renders
// run at most `concurrent` at a time. When cache exceeds `maxCached`, the
// least recently used canvas is dropped — that page reverts to undefined in
// the returned `pageCanvases` map, so downstream BlockCrops drop back to
// placeholder until re-requested.

import { useCallback, useEffect, useRef, useState } from 'react'
import { pdfjs } from 'react-pdf'

if (!pdfjs.GlobalWorkerOptions.workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString()
}

export const PDF_RENDER_SCALE =
  typeof window !== 'undefined'
    ? 2 * (window.devicePixelRatio || 1)
    : 2

export function usePageCache(pdfFile, { maxCached = 8, concurrent = 2 } = {}) {
  const [pageCanvases, setPageCanvases] = useState({})
  const [ready, setReady] = useState(false)

  const pdfDocRef     = useRef(null)
  const cacheRef      = useRef(new Map())   // pn → HTMLCanvasElement
  const lruOrder      = useRef([])           // MRU-first
  const pendingPages  = useRef(new Set())    // pages currently rendering or queued
  const renderQueue   = useRef([])
  const activeRenders = useRef(0)

  useEffect(() => {
    if (!pdfFile) return
    let cancelled = false
    setReady(false)

    pdfjs.getDocument(pdfFile).promise
      .then(doc => {
        if (cancelled) { doc.destroy?.(); return }
        pdfDocRef.current = doc
        setReady(true)
      })
      .catch(err => {
        if (!cancelled) console.error('usePageCache: getDocument failed', err)
      })

    return () => {
      cancelled = true
      const doc = pdfDocRef.current
      pdfDocRef.current = null
      cacheRef.current.clear()
      lruOrder.current = []
      pendingPages.current.clear()
      renderQueue.current = []
      activeRenders.current = 0
      if (doc) doc.destroy?.()
      setPageCanvases({})
      setReady(false)
    }
  }, [pdfFile])

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
    const doc = pdfDocRef.current
    if (!doc) return
    try {
      const page = await doc.getPage(pn)
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE })
      const canvas = document.createElement('canvas')
      canvas.width  = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const ctx = canvas.getContext('2d')
      await page.render({ canvasContext: ctx, viewport }).promise
      if (!pdfDocRef.current) return  // unmounted while rendering
      cacheRef.current.set(pn, canvas)
      touch(pn)
      publish()
      evictIfNeeded()
    } catch (err) {
      if (pdfDocRef.current) console.warn(`usePageCache: render page ${pn} failed`, err)
    }
  }, [touch, publish, evictIfNeeded])

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
    if (!pdfDocRef.current) return
    if (cacheRef.current.has(pn)) {
      touch(pn)
      return
    }
    if (pendingPages.current.has(pn)) return
    pendingPages.current.add(pn)
    renderQueue.current.push(pn)
    processQueue()
  }, [touch, processQueue])

  return { pageCanvases, requestPage, ready }
}
