import { randomUUID } from 'node:crypto'
import type { HubEvent, HubEventType, HubTask, TaskProgress, TaskStatus } from './sdk-types'

/**
 * TaskManager — owns the task lifecycle and the state machine.
 *
 * Deliberately free of transport concerns: the hub server dispatches work in,
 * and this class records progress, completion and cancellation.
 */
export class TaskManager {
  private tasks = new Map<string, HubTask>()
  private listeners = new Map<HubEventType, Set<(event: HubEvent) => void>>()
  private anyListener: ((event: HubEvent) => void) | null = null

  constructor(private opts: { now?: () => number } = {}) {}

  private now() {
    return this.opts.now?.() ?? Date.now()
  }

  public onAny(cb: (event: HubEvent) => void) {
    this.anyListener = cb
  }

  public on(type: HubEventType, cb: (event: HubEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(cb)
  }

  private emit(type: HubEventType, sourceAppId: string, payload: any) {
    const event: HubEvent = {
      eventId: randomUUID(),
      sourceAppId,
      type,
      timestamp: this.now(),
      payload,
    }
    this.listeners.get(type)?.forEach((cb) => {
      try {
        cb(event)
      } catch {
        /* subscriber errors must not break the bus */
      }
    })
    this.anyListener?.(event)
  }

  public create(input: {
    appId: string
    toolId: string
    parameters: Record<string, any>
    priority?: HubTask['priority']
    origin?: HubTask['origin']
  }): HubTask {
    const now = this.now()
    const task: HubTask = {
      taskId: `tsk_${now.toString(36)}_${randomUUID().slice(0, 8)}`,
      appId: input.appId,
      toolId: input.toolId,
      parameters: input.parameters ?? {},
      status: 'pending',
      priority: input.priority ?? 'normal',
      createdAt: now,
      updatedAt: now,
      origin: input.origin ?? 'user',
    }
    this.tasks.set(task.taskId, task)
    return task
  }

  public get(taskId: string): HubTask | undefined {
    return this.tasks.get(taskId)
  }

  public list(filter?: { appId?: string; status?: TaskStatus }): HubTask[] {
    let out = [...this.tasks.values()]
    if (filter?.appId) out = out.filter((t) => t.appId === filter.appId)
    if (filter?.status) out = out.filter((t) => t.status === filter.status)
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  public activeCount(appId: string): number {
    return this.list({ appId }).filter((t) =>
      ['pending', 'awaiting_approval', 'running', 'paused'].includes(t.status)
    ).length
  }

  private touch(task: HubTask) {
    task.updatedAt = this.now()
  }

  public transition(taskId: string, status: TaskStatus): HubTask | null {
    const task = this.tasks.get(taskId)
    if (!task) return null
    task.status = status
    this.touch(task)
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      task.completedAt = this.now()
    }
    return task
  }

  public markDispatched(taskId: string): HubTask | null {
    const task = this.transition(taskId, 'running')
    if (task) {
      this.emit('task.dispatched', task.appId, { taskId, toolId: task.toolId })
    }
    return task
  }

  public markAwaitingApproval(taskId: string): HubTask | null {
    const task = this.transition(taskId, 'awaiting_approval')
    if (task) {
      this.emit('task.approval_required', task.appId, {
        taskId,
        toolId: task.toolId,
        parameters: task.parameters,
      })
    }
    return task
  }

  public updateProgress(taskId: string, progress: TaskProgress): HubTask | null {
    const task = this.tasks.get(taskId)
    if (!task) return null
    task.progress = { ...(task.progress ?? {}), ...progress }
    this.touch(task)
    this.emit('task.progress', task.appId, { taskId, progress: task.progress })
    return task
  }

  public complete(taskId: string, result: any): HubTask | null {
    const task = this.tasks.get(taskId)
    if (!task) return null
    task.status = 'completed'
    task.result = result
    task.error = undefined
    this.touch(task)
    task.completedAt = this.now()
    this.emit('task.completed', task.appId, { taskId, toolId: task.toolId, result })
    return task
  }

  public fail(taskId: string, error: { code: string; message: string }): HubTask | null {
    const task = this.tasks.get(taskId)
    if (!task) return null
    task.status = 'failed'
    task.error = error
    this.touch(task)
    task.completedAt = this.now()
    this.emit('task.failed', task.appId, { taskId, toolId: task.toolId, error })
    return task
  }

  public cancel(taskId: string, reason = 'cancelled by user'): HubTask | null {
    const task = this.tasks.get(taskId)
    if (!task) return null
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task
    task.status = 'cancelled'
    task.error = { code: 'CANCELLED', message: reason }
    this.touch(task)
    task.completedAt = this.now()
    this.emit('task.cancelled', task.appId, { taskId, toolId: task.toolId, reason })
    return task
  }

  public cancelAppTasks(appId: string, reason = 'app went offline'): number {
    let count = 0
    for (const task of this.tasks.values()) {
      if (task.appId !== appId) continue
      if (!['pending', 'awaiting_approval', 'running', 'paused'].includes(task.status)) continue
      this.cancel(task.taskId, reason)
      count++
    }
    return count
  }

  /** Keep memory bounded: drop finished tasks beyond the retention window. */
  public prune(keepLast = 200) {
    const finished = this.list().filter((t) =>
      ['completed', 'failed', 'cancelled'].includes(t.status)
    )
    if (finished.length <= keepLast) return
    for (const task of finished.slice(keepLast)) {
      this.tasks.delete(task.taskId)
    }
  }
}
