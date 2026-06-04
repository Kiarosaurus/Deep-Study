/* eslint-disable react-refresh/only-export-components -- the useEdit hook is
   intentionally co-located with its provider; this only affects HMR. */
import { createContext, useCallback, useContext, useMemo, useState } from 'react'

// Editing state for the reader's bottom-left toolbar (mazo / pincel / lazo +
// undo/redo). The actual block mutations and persistence are layered on top of
// this in Reader (Phase 2): the tools arm a click-mode here, and each completed
// operation is pushed through `commitEdit` as an { apply, revert } pair so the
// undo/redo stack can replay it. A "change" (the unit undo/redo steps over) is
// exactly one application of demote / promote / merge — nothing else.

const EditCtx = createContext(null)

// The click-mode tools. `null` = no tool armed (normal explain clicks).
// 'split' (scissors) cuts a merge. 'search' (lupa) is a 2-click in-paragraph
// text selection that force-extracts a concept from the highlighted fragment.
export const TOOLS = ['demote', 'promote', 'merge', 'split', 'search']

export function EditProvider({ children }) {
  const [armedTool, setArmedTool] = useState(null)
  // Lazo selection buffer: refs of explainable objects clicked while 'merge' is
  // armed, committed together when the user confirms.
  const [mergeBuffer, setMergeBuffer] = useState([])
  // Undo/redo history of { apply, revert } records. `past` is applied state in
  // order; `future` holds records undone and available to redo.
  const [past, setPast] = useState([])
  const [future, setFuture] = useState([])

  // Arming a tool is a toggle: pressing the same tool (button or shortcut)
  // disarms it. Switching tools clears any in-progress lazo selection.
  const armTool = useCallback((tool) => {
    setArmedTool(prev => {
      const next = prev === tool ? null : tool
      if (next !== 'merge') setMergeBuffer([])
      return next
    })
  }, [])

  const disarm = useCallback(() => {
    setArmedTool(null)
    setMergeBuffer([])
  }, [])

  const addToMergeBuffer = useCallback((ref) => {
    setMergeBuffer(prev => (
      prev.some(r => r.key === ref.key) ? prev.filter(r => r.key !== ref.key) : [...prev, ref]
    ))
  }, [])

  const clearMergeBuffer = useCallback(() => setMergeBuffer([]), [])

  // Apply an edit and record it for undo. `record` = { apply, revert, label }.
  // `apply` is invoked now; `revert` undoes it. Committing clears the redo
  // stack (a new branch of history).
  const commitEdit = useCallback((record) => {
    record.apply()
    setPast(p => [...p, record])
    setFuture([])
  }, [])

  const undo = useCallback(() => {
    setPast(p => {
      if (p.length === 0) return p
      const rec = p[p.length - 1]
      rec.revert()
      setFuture(f => [rec, ...f])
      return p.slice(0, -1)
    })
  }, [])

  const redo = useCallback(() => {
    setFuture(f => {
      if (f.length === 0) return f
      const [rec, ...rest] = f
      rec.apply()
      setPast(p => [...p, rec])
      return rest
    })
  }, [])

  const value = useMemo(() => ({
    armedTool, armTool, disarm,
    mergeBuffer, addToMergeBuffer, clearMergeBuffer,
    commitEdit, undo, redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
  }), [armedTool, armTool, disarm, mergeBuffer, addToMergeBuffer, clearMergeBuffer, commitEdit, undo, redo, past.length, future.length])

  return <EditCtx.Provider value={value}>{children}</EditCtx.Provider>
}

export function useEdit() {
  const ctx = useContext(EditCtx)
  if (!ctx) throw new Error('useEdit must be used within an EditProvider')
  return ctx
}
