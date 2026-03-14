import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verifyAccessToken, AuthError } from './auth.js'

describe('runtime auth', () => {
  it('accepts a valid HS256 access token', () => {
    const secret = 'test-secret'
    const token = issueToken(secret, { sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 60 })

    const userID = verifyAccessToken(`Bearer ${token}`, secret)
    assert.strictEqual(userID, 'user-1')
  })

  it('rejects missing authorization', () => {
    assert.throws(
      () => verifyAccessToken(undefined, 'test-secret'),
      (err: unknown) => err instanceof AuthError && err.message === 'missing token',
    )
  })

  it('rejects expired tokens', () => {
    const secret = 'test-secret'
    const token = issueToken(secret, { sub: 'user-1', exp: Math.floor(Date.now() / 1000) - 1 })

    assert.throws(
      () => verifyAccessToken(`Bearer ${token}`, secret),
      (err: unknown) => err instanceof AuthError && err.message === 'invalid or expired token',
    )
  })

  it('rejects tokens with invalid signatures', () => {
    const token = issueToken('one-secret', { sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 60 })

    assert.throws(
      () => verifyAccessToken(`Bearer ${token}`, 'another-secret'),
      (err: unknown) => err instanceof AuthError && err.message === 'invalid or expired token',
    )
  })
})

function issueToken(secret: string, claims: Record<string, unknown>): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const encodedSignature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url')
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`
}
