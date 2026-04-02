/**
 * IndexedDB cache + offline outbox for schema designer cloud sync.
 */

const DB_NAME = 'helix_schema_sync'
const DB_VER = 1
const STORE_CACHE = 'project_cache'
const STORE_OUTBOX = 'outbox'

export type CachedProjectRow = {
  projectId: string
  json: string
  revision: number
  updatedAt: string
}

export type OutboxRow = {
  id?: number
  projectId: string
  payload: string
  clientOpId: string
  createdAt: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        db.createObjectStore(STORE_CACHE, { keyPath: 'projectId' })
      }
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const s = db.createObjectStore(STORE_OUTBOX, {
          keyPath: 'id',
          autoIncrement: true,
        })
        s.createIndex('byProject', 'projectId', { unique: false })
      }
    }
  })
}

function isBrowser(): boolean {
  return typeof indexedDB !== 'undefined'
}

export async function idbPutProjectCache(row: CachedProjectRow): Promise<void> {
  if (!isBrowser()) return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_CACHE, 'readwrite')
    tx.objectStore(STORE_CACHE).put(row)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function idbGetProjectCache(
  projectId: string
): Promise<CachedProjectRow | null> {
  if (!isBrowser()) return null
  const db = await openDb()
  const row = await new Promise<CachedProjectRow | null>((resolve, reject) => {
    const tx = db.transaction(STORE_CACHE, 'readonly')
    const req = tx.objectStore(STORE_CACHE).get(projectId)
    req.onsuccess = () => resolve((req.result as CachedProjectRow) ?? null)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return row
}

export async function idbEnqueueOutbox(row: Omit<OutboxRow, 'id'>): Promise<void> {
  if (!isBrowser()) return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_OUTBOX, 'readwrite')
    tx.objectStore(STORE_OUTBOX).add({
      ...row,
      createdAt: row.createdAt || new Date().toISOString(),
    })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function idbListOutbox(projectId?: string): Promise<OutboxRow[]> {
  if (!isBrowser()) return []
  const db = await openDb()
  const rows = await new Promise<OutboxRow[]>((resolve, reject) => {
    const tx = db.transaction(STORE_OUTBOX, 'readonly')
    const store = tx.objectStore(STORE_OUTBOX)
    const req = store.getAll()
    req.onsuccess = () => {
      let list = (req.result as OutboxRow[]) ?? []
      if (projectId) list = list.filter((r) => r.projectId === projectId)
      resolve(list)
    }
    req.onerror = () => reject(req.error)
  })
  db.close()
  return rows
}

export async function idbRemoveOutboxIds(ids: number[]): Promise<void> {
  if (!isBrowser() || ids.length === 0) return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_OUTBOX, 'readwrite')
    const store = tx.objectStore(STORE_OUTBOX)
    for (const id of ids) {
      store.delete(id)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}
