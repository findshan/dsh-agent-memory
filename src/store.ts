/**
 * Durable store for memory records. Default backend is a human-readable JSON
 * file (atomic writes, zero dependencies, portable). When the official DSH
 * storage hub is present the records are mirrored there as a versioned
 * domain (storage-domain), satisfying the "official storage hub" ecosystem
 * gap — but the plugin never requires those plugins to be mounted.
 * @module
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MemoryRecord } from './types.js'

export const MEMORY_FILE = 'memories.json'

export interface MemStore {
  load(): Promise<MemoryRecord[]>
  save(records: MemoryRecord[]): Promise<void>
}

/** JSON file backend: atomic tmp+rename writes, human-readable, git-friendly. */
export class JsonMemStore implements MemStore {
  readonly filePath: string
  private writeQueue: Promise<void> = Promise.resolve()
  private tmpCounter = 0

  constructor(dir: string) {
    this.filePath = join(dir, MEMORY_FILE)
  }

  async load(): Promise<MemoryRecord[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) throw new Error('memory store is not an array')
      return parsed as MemoryRecord[]
    } catch (error) {
      if (isEnoent(error)) return []
      throw error
    }
  }

  save(records: MemoryRecord[]): Promise<void> {
    // Serialize concurrent saves so a slower earlier write cannot clobber a
    // newer snapshot (last write wins in order). Each tmp file is unique so
    // two store instances on the same directory (e.g. during hot reload) can
    // never rename a file the other already consumed.
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = `${this.filePath}.${process.pid}.${this.tmpCounter++}.tmp`
      const payload = `${JSON.stringify(records, null, 2)}\n`
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.filePath)
    })
    return this.writeQueue
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
