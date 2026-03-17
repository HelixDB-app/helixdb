'use client'

import { useEffect } from 'react'
import { useSchemaStore } from '@/lib/schema-store'

const STORAGE_KEY = 'schema-designer-state'

export function useLocalStorage() {
  const { tables, relationships, setCode } = useSchemaStore()

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const { tables, relationships, code } = JSON.parse(stored)
        // Reset store and load saved state
        useSchemaStore.setState({
          tables,
          relationships,
          code,
        })
      }
    } catch (error) {
      console.error('Failed to load from localStorage:', error)
    }
  }, [])

  // Save to localStorage whenever tables or relationships change
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          tables,
          relationships,
          code: useSchemaStore.getState().code,
        })
      )
    } catch (error) {
      console.error('Failed to save to localStorage:', error)
    }
  }, [tables, relationships])

  const clearStorage = () => {
    localStorage.removeItem(STORAGE_KEY)
    useSchemaStore.getState().reset()
  }

  return { clearStorage }
}
