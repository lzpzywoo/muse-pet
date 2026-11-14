/**
 * Example: A third-party local download manager integrating with Muse Pet via Local Agent Hub.
 *
 * Can be run via: `node examples/third-party-app.cjs` while Muse Pet is running.
 */
const HUB_URL = 'http://127.0.0.1:19840'
const APP_ID = 'com.example.downloader'
const SECRET = 'downloader-demo-secret-12345'

async function main() {
  console.log('Connecting to Muse Local Agent Hub at', HUB_URL, '...')

  // 1. Register with the Hub
  const regRes = await (await fetch(`${HUB_URL}/api/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: APP_ID,
      name: '极速下载器 (Demo)',
      version: '1.0.0',
      description: '本地多线程下载器，可查询当前下载队列与创建下载任务',
      secret: SECRET,
      tools: [
        {
          toolId: 'list_queue',
          name: '查看下载队列',
          description: '获取当前所有正在下载或排队的文件列表和进度百分比',
          category: 'query',
          riskLevel: 'read-only',
          inputSchema: { type: 'object' },
        },
        {
          toolId: 'add_download',
          name: '添加下载链接',
          description: '添加一个新的 URL 下载任务到本地',
          category: 'action',
          riskLevel: 'write-safe',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: '文件下载链接' },
              saveName: { type: 'string', description: '保存文件名' },
            },
            required: ['url'],
          },
        },
      ],
    }),
  })).json()

  if (!regRes.ok) {
    console.error('Registration failed:', regRes.error)
    process.exit(1)
  }

  const { sessionToken, heartbeatTimeoutMs } = regRes.data
  console.log('✅ Registered with Hub! Session token:', sessionToken.slice(0, 16) + '...')

  // 2. Connect WebSocket for tasks and events
  const ws = new WebSocket(`ws://127.0.0.1:19840/ws?appId=${APP_ID}&secret=${SECRET}`)

  ws.onopen = () => {
    console.log('✅ WebSocket event stream connected.')
  }

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'hub.connected') {
      console.log('Hub handshake complete.')
      return
    }

    if (msg.type === 'task.dispatched') {
      const { taskId, payload } = msg
      console.log(`📥 收到来自 Luna / 用户的任务: [${payload.toolId}]`, payload.parameters)

      if (payload.toolId === 'list_queue') {
        // Return active downloads
        ws.send(JSON.stringify({
          type: 'task.completed',
          taskId,
          payload: {
            result: {
              activeCount: 1,
              items: [
                { name: 'Ubuntu-24.04-desktop.iso', progress: '78%', speed: '12.4 MB/s', eta: '2m 14s' },
              ],
            },
          },
        }))
        console.log(`📤 任务已完成并上报结果 [${taskId}]`)
      } else if (payload.toolId === 'add_download') {
        // Report progress then complete
        ws.send(JSON.stringify({
          type: 'task.progress',
          taskId,
          payload: { percentage: 20, message: '正在连接服务器...' },
        }))
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'task.completed',
            taskId,
            payload: {
              result: {
                message: `已成功创建下载任务: ${payload.parameters?.url}`,
                taskId,
              },
            },
          }))
          console.log(`📤 下载任务已启动并上报完成 [${taskId}]`)
        }, 1000)
      }
    }
  }

  // 3. Heartbeat loop
  setInterval(async () => {
    try {
      await fetch(`${HUB_URL}/api/v1/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'X-App-Id': APP_ID,
        },
        body: JSON.stringify({ status: 'active', activeTasks: 1 }),
      })
    } catch (err) {
      console.warn('Heartbeat failed:', err.message)
    }
  }, 20000)

  console.log('Ready and waiting for Luna commands. Press Ctrl+C to exit.')
}

main().catch(console.error)
