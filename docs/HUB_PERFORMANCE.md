# Hub Conversation Performance and Diagnostics

A Hub query spans several independent stages: cloud generation of a tool request, local observation and dispatch, the third-party handler, submission of its result, and cloud generation of the final answer. Measure them separately before changing timeouts or polling rates.

## Desktop behavior

Internal request JSON, controller metadata, result reports and success-delivery placeholders are hidden by a display-only projection. Natural-language content, image attachments, actual failures and approval controls remain visible. Raw conversation history and the execution ledger are preserved; hiding is not data deletion. `/hub` remains the diagnostic view for real tasks and results.

Muse still uses a web conversation relay. These display rules apply to the Muse Pet desktop, not to the underlying messages stored by the Muse website.

## Local scheduling

- Idle lightweight observations: 4500 ms.
- Active lightweight observations: 500 ms, enabled in bounded windows of at most 20 seconds per boost.
- Rich-message refresh: no more often than 1500 ms during activity, with one extraction in flight shared by concurrent callers.
- Browser-status checks: 4500 ms.
- Completed turns explicitly request an immediate observation and rich refresh; rich media extraction does not keep the composer lock held.
- A DOM-ready assistant response is actionable only after the local sender releases the composer. This avoids prematurely executing a read whose result cannot yet be submitted.

The model-completion boundary, account/conversation checks, request baseline, receipt ownership, read-only limits and uncertain-send handling remain intact. Faster observation never grants execution authority.

## Receipt compatibility

The website may prefix report text with a role label such as `你：` followed by two line breaks. The receipt normalizer handles known role labels and up to two transport line breaks; it does not generally trim or accept arbitrary wrappers. Forged and reused reports remain unauthorized.

A chain that never completes should be diagnosed as a stalled chain, not reported as a slow model response. Check the exploration root's stop reason, whether the next tool task was actually created, and whether a result was submitted.

## Third-party adapter profiling

A measured `software_read` duration includes adapter scheduling, transport, and upstream data queries. Muse Pet cannot remove that time by polling its own window more often.

For the current ThinkRail example, profile these operations individually in `ThinkRailSessionReader.list`:

1. WebSocket connection and handshake.
2. `session.stateList` and `project.list` (already requested concurrently in the inspected implementation).
3. `workspace.list` fan-out for projects.
4. Per-selected-session `todo.list` requests, which the inspected reader executes sequentially.

Do not assume which RPC is slow without recording it. Confirm the adapter's actual `THINKRAIL_WS_URL`; failure against a guessed/default port does not establish that the configured service is offline.

A timing wrapper can record method names and elapsed durations without logging workspace/session IDs, parameters, results, messages, or credentials:

```ts
async function measured<T>(method: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now()
  let ok = false
  try {
    const result = await work()
    ok = true
    return result
  } finally {
    console.info('[hub-timing]', { method, ok, durationMs: Math.round(performance.now() - start) })
  }
}

const records = await measured('session.stateList', () =>
  connection.request('session.stateList', {}, sessionQueryTimeoutMs))
```

Possible provider-side improvements, after profiling:

- Obtain active-state summaries from a batched or event-maintained query rather than loading full histories.
- Filter to relevant sessions before querying detailed plans; query only the requested session's details.
- Use bounded concurrency for independent plan reads instead of serial RPCs.
- Reuse a healthy authenticated connection where the service supports it.
- If returning cached state, label its source and sample time honestly. Never translate timeouts into `ok` with an empty session list.

These are adapter-side recommendations; Muse Pet does not modify the ThinkRail project or infer real state from directory timestamps.

## Measurement interpretation

A single live run is useful for diagnosing a stall or a slow handler, but does not establish a stable cloud-model speed-up percentage. Report tool count, per-tool durations, local handoff gaps, completion/timeout status, and the final answer timing. Keep timing artifacts free of conversation bodies and credentials.
