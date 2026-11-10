import { app, safeStorage } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { UserProfile } from '../types'

interface StoredSession {
  cookies: string
  profile: UserProfile
  updatedAt: number
}

export class SessionStore {
  private filePath: string
  private session: StoredSession | null = null

  constructor() {
    const userData = app.getPath('userData')
    this.filePath = path.join(userData, 'muse_session.enc')
    if (app.isReady()) {
      this.load()
    }
  }

  public init() {
    this.load()
  }

  private load() {
    if (!fs.existsSync(this.filePath)) return
    try {
      const encryptedData = fs.readFileSync(this.filePath)
      if (safeStorage.isEncryptionAvailable()) {
        let decrypted: string
        try {
          decrypted = safeStorage.decryptString(encryptedData)
        } catch (decryptErr) {
          // Key changed or file corrupted — delete and start fresh
          console.warn('Session decryption failed, clearing corrupted session file:', decryptErr)
          this.clearFile()
          return
        }
        try {
          this.session = JSON.parse(decrypted)
        } catch (parseErr) {
          console.warn('Session JSON parse failed after decryption, clearing:', parseErr)
          this.clearFile()
        }
      } else {
        // safeStorage unavailable — file should be plain UTF-8 JSON
        try {
          this.session = JSON.parse(encryptedData.toString('utf-8'))
        } catch {
          console.warn('Session file is not valid JSON (may be encrypted from another run), clearing.')
          this.clearFile()
        }
      }
    } catch (e) {
      console.error('Failed to load session file:', e)
      this.session = null
    }
  }

  private clearFile() {
    this.session = null
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath)
      }
    } catch (e) {
      console.error('Failed to delete corrupted session file:', e)
    }
  }

  public save(cookies: string, profile: UserProfile) {
    this.session = {
      cookies,
      profile,
      updatedAt: Date.now(),
    }

    try {
      const serialized = JSON.stringify(this.session)
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(serialized)
        fs.writeFileSync(this.filePath, encrypted)
      } else {
        fs.writeFileSync(this.filePath, Buffer.from(serialized, 'utf-8'))
      }
    } catch (e) {
      console.error('Failed to save session:', e)
    }
  }

  public clear() {
    this.clearFile()
  }

  public getCookies(): string {
    return this.session?.cookies || ''
  }

  public getProfile(): UserProfile {
    return (
      this.session?.profile || {
        isLoggedIn: false,
      }
    )
  }

  public isLoggedIn(): boolean {
    return !!(this.session?.cookies && this.session.profile.isLoggedIn)
  }
}
