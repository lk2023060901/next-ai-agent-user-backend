import { createServer } from 'node:http'
import { verifyAccessToken, AuthError } from './auth.js'
import { matchRoute as matchWorkflowRoute, getRunManager as getWorkflowRunManager } from './workflow/routes.js'
import { matchRoute as matchIssueRunRoute, getIssueRunManager } from './issue-runs/routes.js'

const PORT = process.env.PORT || '3002'

const server = createServer(async (req, res) => {
  const url = (req.url ?? '').split('?')[0]
  const method = req.method ?? 'GET'

  // Health check
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (url !== '/health') {
    try {
      verifyAccessToken(typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined)
    } catch (err) {
      const authErr = err instanceof AuthError
        ? err
        : new AuthError('UNAUTHORIZED', 'invalid or expired token')
      res.writeHead(authErr.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: authErr.code, message: authErr.message }))
      return
    }
  }

  // Route matching
  const match = matchIssueRunRoute(method, url) ?? matchWorkflowRoute(method, url)
  if (match) {
    try {
      await match.handler(req, res, match.params)
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 'INTERNAL_ERROR', message: String(err) }))
      }
    }
    return
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }))
})

// Graceful shutdown
function shutdown() {
  console.log('runtime shutting down...')
  getIssueRunManager().shutdown()
  getWorkflowRunManager().shutdown()
  server.close(() => {
    console.log('runtime stopped')
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(Number(PORT), () => {
  console.log(`runtime listening on :${PORT}`)
})
