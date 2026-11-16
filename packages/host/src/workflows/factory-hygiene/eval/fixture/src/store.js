import { readFileSync, writeFileSync } from 'node:fs'

/** Keeps every job in one JSON file and rewrites it on each change. */
export class FileStore {
  constructor(file) {
    this.file = file
    this.jobs = new Map()
    this.nextId = 1
  }

  load() {
    const saved = JSON.parse(readFileSync(this.file, 'utf8'))
    this.jobs = new Map(saved.map((job) => [job.id, job]))
    this.nextId = Math.max(0, ...this.jobs.keys()) + 1
  }

  insert(fields) {
    const job = { id: this.nextId++, ...fields }
    this.jobs.set(job.id, job)
    this.persist()
    return job
  }

  update(id, fields) {
    const job = { ...this.jobs.get(id), ...fields }
    this.jobs.set(id, job)
    this.persist()
    return job
  }

  remove(id) {
    this.jobs.delete(id)
    this.persist()
  }

  all() {
    return [...this.jobs.values()]
  }

  persist() {
    writeFileSync(this.file, JSON.stringify(this.all()))
  }
}
