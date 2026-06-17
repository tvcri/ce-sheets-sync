import { test } from 'node:test'
import assert from 'node:assert'
import { resolveStatus } from '../lib/db-sync.js'

test('resolveStatus', async (t) => {
  await t.test('returns Completed when status is Confirmed and finish_at is before timestamp', () => {
    const row = { status: 'Confirmed', finish_at: '2026-06-01 10:00:00' }
    const timestamp = new Date('2026-06-02T00:00:00.000Z')
    assert.strictEqual(resolveStatus(row, timestamp), 'Completed')
  })

  await t.test('returns Confirmed when status is Confirmed and finish_at is after timestamp', () => {
    const row = { status: 'Confirmed', finish_at: '2026-06-10 10:00:00' }
    const timestamp = new Date('2026-06-02T00:00:00.000Z')
    assert.strictEqual(resolveStatus(row, timestamp), 'Confirmed')
  })

  await t.test('returns Confirmed when status is Confirmed and finish_at is null', () => {
    const row = { status: 'Confirmed', finish_at: null }
    const timestamp = new Date('2026-06-02T00:00:00.000Z')
    assert.strictEqual(resolveStatus(row, timestamp), 'Confirmed')
  })

  await t.test('returns Confirmed when status is Confirmed and timestamp is null', () => {
    const row = { status: 'Confirmed', finish_at: '2026-06-01 10:00:00' }
    assert.strictEqual(resolveStatus(row, null), 'Confirmed')
  })

  await t.test('passes through non-Confirmed statuses unchanged', () => {
    const row = { status: 'Completed', finish_at: '2026-06-01 10:00:00' }
    const timestamp = new Date('2026-06-02T00:00:00.000Z')
    assert.strictEqual(resolveStatus(row, timestamp), 'Completed')
  })

  await t.test('passes through Open status unchanged', () => {
    const row = { status: 'Open', finish_at: null }
    const timestamp = new Date('2026-06-02T00:00:00.000Z')
    assert.strictEqual(resolveStatus(row, timestamp), 'Open')
  })
})
