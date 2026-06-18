import { test } from 'node:test'
import assert from 'node:assert'
import { normalizeVillageName, mapActivityTypes } from '../lib/fcv-sync.js'

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
        'Outing ( events, movies, Sr Center,  etc.)',
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
})
