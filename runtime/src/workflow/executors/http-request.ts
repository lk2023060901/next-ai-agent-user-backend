import type { NodeExecutor } from '../types.js'

export const httpRequestExecutor: NodeExecutor = async (ctx) => {
  const url = ctx.getInput('url') as string
  const body = ctx.getInput('body') as unknown
  const method = (ctx.properties.method as string) ?? 'GET'
  const headers = (ctx.properties.headers as Record<string, string>) ?? {}
  const timeoutMs = (ctx.properties.timeoutMs as number) ?? 30000

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const init: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      signal: controller.signal,
    }
    if (body && method !== 'GET') {
      init.body = JSON.stringify(body)
    }

    const res = await fetch(url, init)
    clearTimeout(timer)

    let responseBody: unknown
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      responseBody = await res.json()
    } else {
      responseBody = await res.text()
    }

    ctx.setOutput('response', responseBody)
    ctx.setOutput('statusCode', res.status)
    return res.ok ? 'exec_out' : 'exec_error'
  } catch {
    ctx.setOutput('response', null)
    ctx.setOutput('statusCode', 0)
    return 'exec_error'
  }
}
