import { EventEmitter } from 'node:events'
import type { HubEvent, HubEventType } from './sdk-types'

/**
 * EventBus — internal pub/sub used to fan hub events out to the renderer
 * processes (pet bubbles, terminal cards) and to the cloud bridge.
 *
 * WebSocket fan-out to integrated apps is handled by the hub server; this bus
 * is for in-process consumers only.
 */
export class HubEventBus extends EventEmitter {
  public publish(event: HubEvent) {
    this.emit(event.type, event)
    this.emit('*', event)
  }

  public subscribe<T = any>(
    type: HubEventType | '*',
    handler: (event: HubEvent & { payload: T }) => void
  ): () => void {
    this.on(type, handler as any)
    return () => this.off(type, handler as any)
  }
}
