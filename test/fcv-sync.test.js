import { test, mock } from 'node:test'
import assert from 'node:assert'
import { normalizeVillageName, mapActivityTypes, fuzzyMatchNames } from '../lib/fcv-sync.js'

test('normalizeVillageName', async (t) => {
  await t.test('maps Aquidneck Island to Aquidneck', () => {
    assert.strictEqual(normalizeVillageName('Aquidneck Island'), 'Aquidneck')
  })

  await t.test('passes through other village names unchanged', () => {
    assert.strictEqual(normalizeVillageName('Barrington'), 'Barrington')
    assert.strictEqual(normalizeVillageName('Providence'), 'Providence')
  })
})

test('mapActivityTypes', async (t) => {
  await t.test('maps known full strings to short forms', () => {
    assert.deepStrictEqual(
      mapActivityTypes([
        'Companionship/Friendly Conversation (sharing stories, current events, photos)',
        'Dining out'
      ]),
      ['companionship', 'dining']
    )
  })

  await t.test('maps all known activity types', () => {
    assert.deepStrictEqual(
      mapActivityTypes([
        'Companionship/Friendly Conversation (sharing stories, current events, photos)',
        'Shared Activity (board game, cards, puzzles, craft)',
        'Assistance (reading aloud, writing a letter, helping with simple tasks)',
        'Outdoors (walking, gardening, birding, etc)',
        'Outing (\xa0events, movies, Sr Center,\xa0 etc.)',
        'Dining out',
        'Wellness check-in (follow up after illness or hospitalization)',
        'Pet visit',
        'Other'
      ]),
      ['companionship', 'activity', 'assistance', 'outdoors', 'outing', 'dining', 'wellness', 'pet', 'other']
    )
  })

  await t.test('returns empty array for empty input', () => {
    assert.deepStrictEqual(mapActivityTypes([]), [])
  })

  await t.test('returns empty array for undefined input', () => {
    assert.deepStrictEqual(mapActivityTypes(undefined), [])
  })

  await t.test('handles dict form with only other key', () => {
    assert.deepStrictEqual(
      mapActivityTypes({ other: 'Sent a postcard' }),
      ['other']
    )
  })

  await t.test('handles dict form with numeric keys and other key', () => {
    assert.deepStrictEqual(
      mapActivityTypes({ '0': 'Companionship/Friendly Conversation (sharing stories, current events, photos)', '1': 'Dining out', other: 'shopping' }),
      ['companionship', 'dining', 'other']
    )
  })
})

test('fuzzyMatchNames', async (t) => {
  const personNames = ['Albrektson, David', 'Bauer, Debra', 'Minifie, Elizabeth']

  await t.test('returns correction map from API response', async () => {
    const mockResponse = { 'Albreksten, David': 'Albrektson, David', 'Bauer, Deb': 'Bauer, Debra' }
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ text: JSON.stringify(mockResponse) }] })
    })
    const result = await fuzzyMatchNames(['Albreksten, David', 'Bauer, Deb'], personNames, 'test-key')
    assert.deepStrictEqual(result, mockResponse)
  })

  await t.test('returns null entries for unresolvable names', async () => {
    const mockResponse = { 'Xxx, Xxx': null }
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ text: JSON.stringify(mockResponse) }] })
    })
    const result = await fuzzyMatchNames(['Xxx, Xxx'], personNames, 'test-key')
    assert.deepStrictEqual(result, { 'Xxx, Xxx': null })
  })

  await t.test('handles markdown code fence wrapping JSON response', async () => {
    const mockResponse = { 'Bauer, Deb': 'Bauer, Debra' }
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ text: '```json\n' + JSON.stringify(mockResponse) + '\n```' }] })
    })
    const result = await fuzzyMatchNames(['Bauer, Deb'], personNames, 'test-key')
    assert.deepStrictEqual(result, mockResponse)
  })

  await t.test('throws on non-OK API response', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401 })
    await assert.rejects(
      () => fuzzyMatchNames(['Bauer, Deb'], personNames, 'bad-key'),
      /Anthropic API returned 401/
    )
  })
})
