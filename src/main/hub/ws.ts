import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'

/**
 * Minimal RFC 6455 WebSocket server support built on Node primitives.
 * Only what the Local Agent Hub needs: text frames, ping/pong, close.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function acceptKey(secWebSocketKey: string): string {
  return createHash('sha1').update(secWebSocketKey + GUID).digest('base64')
}

export interface WsConnection {
  send(data: string): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: string) => void): void
  onClose(cb: () => void): void
  readonly isOpen: boolean
}

/** Attach a WebSocket connection to an upgraded socket. */
export function attachWebSocket(socket: Duplex): WsConnection {
  let open = true
  let messageHandler: ((data: string) => void) | null = null
  let closeHandler: (() => void) | null = null
  let buffer: Buffer = Buffer.alloc(0)

  const sendFrame = (opcode: number, payload: Buffer) => {
    if (!open) return
    const len = payload.length
    let header: Buffer
    if (len < 126) {
      header = Buffer.alloc(2)
      header[0] = 0x80 | opcode
      header[1] = len
    } else if (len < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    try {
      socket.write(Buffer.concat([header, payload]))
    } catch {
      open = false
    }
  }

  const encodeText = (text: string) => sendFrame(0x1, Buffer.from(text, 'utf8'))

  const decodeFrames = () => {
    while (open) {
      if (buffer.length < 2) return
      const first = buffer[0]
      const second = buffer[1]
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let len = second & 0x7f
      let offset = 2

      if (len === 126) {
        if (buffer.length < offset + 2) return
        len = buffer.readUInt16BE(offset)
        offset += 2
      } else if (len === 127) {
        if (buffer.length < offset + 8) return
        len = Number(buffer.readBigUInt64BE(offset))
        offset += 8
      }

      let maskKey: Buffer | null = null
      if (masked) {
        if (buffer.length < offset + 4) return
        maskKey = buffer.subarray(offset, offset + 4)
        offset += 4
      }

      if (buffer.length < offset + len) return
      let payload = buffer.subarray(offset, offset + len)
      if (maskKey) {
        payload = Buffer.from(payload)
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4]
        }
      }
      buffer = buffer.subarray(offset + len)

      if (opcode === 0x8) {
        open = false
        try {
          socket.end()
        } catch {
          /* already closed */
        }
        closeHandler?.()
        return
      }
      if (opcode === 0x9) {
        sendFrame(0xa, payload)
        continue
      }
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode === 0x1) {
          messageHandler?.(payload.toString('utf8'))
        }
      }
    }
  }

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    decodeFrames()
  })

  socket.on('error', () => {
    if (open) {
      open = false
      closeHandler?.()
    }
  })

  socket.on('close', () => {
    if (open) {
      open = false
      closeHandler?.()
    }
  })

  return {
    get isOpen() {
      return open
    },
    send: encodeText,
    close(code = 1000, reason = '') {
      if (!open) return
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
      payload.writeUInt16BE(code, 0)
      payload.write(reason, 2)
      sendFrame(0x8, payload)
      open = false
      try {
        socket.end()
      } catch {
        /* already closed */
      }
    },
    onMessage(cb) {
      messageHandler = cb
    },
    onClose(cb) {
      closeHandler = cb
    },
  }
}
