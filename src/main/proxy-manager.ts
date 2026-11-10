import { session, app, net } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { ProxyConfig, NetworkTestResult } from '../types'

export class ProxyManager {
  private configPath: string
  private currentConfig: ProxyConfig = { mode: 'system' }

  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'proxy_config.json')
    this.load()
  }

  private load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8')
        this.currentConfig = JSON.parse(raw)
      }
    } catch (e) {
      console.warn('Failed to load proxy config, using default system proxy:', e)
      this.currentConfig = { mode: 'system' }
    }
  }

  private save() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.currentConfig, null, 2))
    } catch (e) {
      console.warn('Failed to save proxy config:', e)
    }
  }

  public getConfig(): ProxyConfig {
    return { ...this.currentConfig }
  }

  public async setConfig(config: ProxyConfig): Promise<boolean> {
    this.currentConfig = config
    this.save()
    await this.apply()
    return true
  }

  public async apply(): Promise<void> {
    const sessions = [
      session.defaultSession,
      session.fromPartition('persist:meta_muse'),
    ]

    for (const sess of sessions) {
      try {
        if (this.currentConfig.mode === 'system') {
          // System proxy (default)
          await sess.setProxy({ mode: 'system' })
        } else if (this.currentConfig.mode === 'custom' && this.currentConfig.customRules) {
          // Custom proxy, e.g. http://127.0.0.1:7890 or socks5://127.0.0.1:1080
          await sess.setProxy({
            mode: 'fixed_servers',
            proxyRules: this.currentConfig.customRules,
          })
        } else {
          // Direct (no proxy)
          await sess.setProxy({ mode: 'direct' })
        }
      } catch (err) {
        console.error('Failed to apply proxy configuration to session:', err)
      }
    }
  }

  public async testConnection(url = 'https://muse.ai'): Promise<NetworkTestResult> {
    const start = Date.now()
    try {
      const response = await net.fetch(url, {
        method: 'HEAD',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
      })
      const latencyMs = Date.now() - start
      return {
        success: response.ok || response.status < 400 || response.status === 403, // 403 is still network reachable
        status: response.status,
        latencyMs,
        message: `HTTP ${response.status} (${latencyMs}ms)`,
      }
    } catch (err: any) {
      return {
        success: false,
        latencyMs: Date.now() - start,
        message: err.message || '网络连接超时或无法访问目标域名',
      }
    }
  }
}
