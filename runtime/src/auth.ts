import { createHmac, timingSafeEqual } from 'node:crypto'

const DEFAULT_JWT_SECRET = 'dev-jwt-secret-change-in-production'

interface AccessTokenClaims {
  sub?: string
  exp?: number
  iat?: number
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 401,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

export function verifyAccessToken(authorization: string | undefined, jwtSecret = process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET): string {
  const token = extractBearerToken(authorization)
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.')
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new AuthError('UNAUTHORIZED', 'invalid token format')
  }

  const header = decodeJSON<{ alg?: string; typ?: string }>(encodedHeader)
  if (header.alg !== 'HS256' || header.typ !== 'JWT') {
    throw new AuthError('UNAUTHORIZED', 'invalid token')
  }

  const expectedSignature = signHS256(`${encodedHeader}.${encodedPayload}`, jwtSecret)
  if (!safeEqual(expectedSignature, encodedSignature)) {
    throw new AuthError('UNAUTHORIZED', 'invalid or expired token')
  }

  const claims = decodeJSON<AccessTokenClaims>(encodedPayload)
  if (typeof claims.sub !== 'string' || claims.sub.trim() === '') {
    throw new AuthError('UNAUTHORIZED', 'invalid or expired token')
  }
  if (typeof claims.exp === 'number' && claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new AuthError('UNAUTHORIZED', 'invalid or expired token')
  }

  return claims.sub
}

function extractBearerToken(authorization: string | undefined): string {
  if (!authorization) {
    throw new AuthError('UNAUTHORIZED', 'missing token')
  }
  const [scheme, token] = authorization.split(' ')
  if (scheme !== 'Bearer' || !token) {
    throw new AuthError('UNAUTHORIZED', 'invalid token format')
  }
  return token
}

function decodeJSON<T>(segment: string): T {
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8')
    return JSON.parse(json) as T
  } catch {
    throw new AuthError('UNAUTHORIZED', 'invalid token')
  }
}

function signHS256(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message).digest('base64url')
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }
  return timingSafeEqual(leftBuffer, rightBuffer)
}
