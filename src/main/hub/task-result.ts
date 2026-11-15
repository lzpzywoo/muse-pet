import type { HubServer } from './hub-server'

/** Wait for a tracked builtin result without losing an early completion event. */
export function waitForHubResult(hub: HubServer, taskId: string, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let finished = false
    let unsubscribe = () => {}
    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      unsubscribe()
      hub.cancelTask(taskId, '等待工具结果超时')
      reject(new Error('等待工具结果超时'))
    }, timeoutMs)
    const inspect = () => {
      const task = hub.tasks.get(taskId)
      if (!task || !['completed', 'failed', 'cancelled'].includes(task.status)) return
      if (finished) return
      finished = true
      clearTimeout(timer)
      unsubscribe()
      if (task.status === 'completed') resolve(task.result)
      else reject(new Error(task.error?.message || '工具任务未完成'))
    }
    unsubscribe = hub.bus.subscribe('*', event => {
      if (event.payload?.taskId === taskId) inspect()
    })
    inspect()
  })
}
