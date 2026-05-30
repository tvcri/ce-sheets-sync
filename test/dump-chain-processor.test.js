import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import { DumpChainData } from '../lib/dump-chain-processor.js'

const sampleCsv = fs.readFileSync('./test/fixtures/sample-dump-chain.csv', 'utf-8')

test('DumpChainData date formatting', async (t) => {
  const data = DumpChainData.from(sampleCsv)
  const metroData = data.getMetroAreaData('Aquidneck')

  await t.test('formats member birthday and join date to ISO', () => {
    const member = metroData.tabs.Members[0]
    if (member.Birthday) {
      assert.match(member.Birthday, /^\d{4}-\d{2}-\d{2}/, 'Birthday should be ISO format')
    }
    if (member['Join Date']) {
      assert.match(member['Join Date'], /^\d{4}-\d{2}-\d{2}/, 'Join Date should be ISO format')
    }
  })

  await t.test('formats service dates to ISO in request tabs', () => {
    const requestOpen = metroData.tabs['Requests Open'][0]
    if (requestOpen['Created Date/Time']) {
      assert.match(requestOpen['Created Date/Time'], /^\d{4}-\d{2}-\d{2}/, 'Created Date should be ISO format')
    }
  })

  await t.test('converts ISO times to 12-hour display format in Requests tabs', () => {
    const requestOpen = metroData.tabs['Requests Open'][0]
    if (requestOpen['Created Date/Time'] && requestOpen['Created Date/Time'].includes(':')) {
      assert.match(requestOpen['Created Date/Time'], /(AM|PM)$/, 'Display format should include AM/PM')
    }
  })
})

test('DumpChainData parsing and section splitting', async (t) => {
  await t.test('DumpChainData.from() parses CSV and creates instance', () => {
    const data = DumpChainData.from(sampleCsv)
    assert.ok(data, 'should create a DumpChainData instance')
  })

  await t.test('throws on empty CSV', () => {
    assert.throws(() => {
      DumpChainData.from('')
    }, /CSV produced no parseable sections/)
  })

  await t.test('parses all sections from sample fixture', () => {
    const data = DumpChainData.from(sampleCsv)
    const metroAreas = data.metroAreas()
    assert.ok(metroAreas.length > 0, 'should find metro areas')
    assert.ok(metroAreas.includes('Aquidneck'), 'should have Aquidneck')
  })
})

test('DumpChainData.hasMetroArea()', async (t) => {
  const data = DumpChainData.from(sampleCsv)

  await t.test('returns true when metro area exists', () => {
    assert.ok(data.hasMetroArea('Aquidneck'))
  })

  await t.test('returns false when metro area is absent', () => {
    assert.ok(!data.hasMetroArea('NonexistentMetroArea'))
  })
})

test('DumpChainData.getMetroAreaData()', async (t) => {
  const data = DumpChainData.from(sampleCsv)

  await t.test('returns object with tabs and analytics', () => {
    const metroData = data.getMetroAreaData('Aquidneck')
    assert.ok(metroData.tabs)
    assert.ok(metroData.tabs.Members)
    assert.ok(metroData.tabs.Volunteers)
    assert.ok(metroData.tabs['Requests Open'])
    assert.ok(metroData.tabs['Requests Confirmed'])
    assert.ok(metroData.tabs['Requests History'])
    assert.ok(metroData.providerNames instanceof Set)
    assert.ok(metroData.memberNames instanceof Set)
    assert.ok(Array.isArray(metroData.providerCounts))
    assert.ok(Array.isArray(metroData.memberCounts))
    assert.ok(Array.isArray(metroData.categoryCounts))
    assert.ok(Array.isArray(metroData.serviceCounts))
    assert.ok(typeof metroData.memberVolunteerCounts === 'object')
  })

  await t.test('removes Metro Area column from Members tab', () => {
    const metroData = data.getMetroAreaData('Aquidneck')
    assert.ok(metroData.tabs.Members.every(m => !m.hasOwnProperty('Metro Area')))
  })

  await t.test('filters Member Added from Requests History', () => {
    const metroData = data.getMetroAreaData('Aquidneck')
    const hasAddedRecords = metroData.tabs['Requests History'].some(r => r['Service Name'] === 'Member Added')
    assert.ok(!hasAddedRecords, 'should not have Member Added in history')
  })

  await t.test('includes SRLog filter result in Volunteers', () => {
    const metroData = data.getMetroAreaData('Aquidneck')
    const hasSRLog = metroData.tabs.Volunteers.some(v => v['Name'].startsWith('SRLog,'))
    assert.ok(!hasSRLog, 'should filter out SRLog entries')
  })

  await t.test('singularizes category names', () => {
    const metroData = data.getMetroAreaData('Aquidneck')
    const volunteers = metroData.tabs.Volunteers
    volunteers.forEach(v => {
      if (v['Errand'] === '✓') {
        assert.ok(!v['Errands'], 'should use singular Errand not Errands')
      }
      if (v['Ride'] === '✓') {
        assert.ok(!v['Rides'], 'should use singular Ride not Rides')
      }
    })
  })

  await t.test('includes provider and member name sets for cross-section lookup', () => {
    const metroData = data.getMetroAreaData('Aquidneck')
    if (metroData.tabs.Members.length > 0) {
      const member = metroData.tabs.Members[0]
      const nameStr = member['Name'].trim()
      assert.ok(typeof nameStr === 'string')
      assert.ok(metroData.memberNames.has(nameStr), 'member names should be in memberNames set')
    }
  })
})

test('DumpChainData.getHubData()', async (t) => {
  const data = DumpChainData.from(sampleCsv)

  await t.test('returns hub data with aggregations', () => {
    const metroAreas = data.metroAreas()
    const metroAreaConfig = Object.fromEntries(metroAreas.map(ma => [ma, 'dummy-sheet-id']))
    const hubData = data.getHubData(metroAreaConfig)
    assert.ok(typeof hubData.memberVolunteerCounts === 'object')
    assert.ok(Array.isArray(hubData.categoryCounts))
    assert.ok(Array.isArray(hubData.providerTotals))
    assert.ok(Array.isArray(hubData.memberTotals))
    assert.ok(Array.isArray(hubData.serviceCounts))
  })

  await t.test('aggregates provider and member totals per metro area', () => {
    const metroAreas = data.metroAreas()
    const metroAreaConfig = Object.fromEntries(metroAreas.map(ma => [ma, 'dummy-sheet-id']))
    const hubData = data.getHubData(metroAreaConfig)
    if (metroAreas.length > 0) {
      assert.ok(hubData.providerTotals.length > 0, 'should have provider totals')
      assert.ok(hubData.memberTotals.length > 0, 'should have member totals')
      hubData.providerTotals.forEach(pt => {
        assert.ok(Array.isArray(pt) && pt.length === 3, 'provider total should have [metroArea, confirmed, completed]')
      })
      hubData.memberTotals.forEach(mt => {
        assert.ok(Array.isArray(mt) && mt.length === 6, 'member total should have [metroArea, unmatched, cancelled, open, confirmed, completed]')
      })
    }
  })
})

test('DumpChainData member/volunteer counts', async (t) => {
  const data = DumpChainData.from(sampleCsv)

  await t.test('counts members only, volunteers only, and both', () => {
    const metroData = data.getMetroAreaData('Aquidneck')
    const counts = metroData.memberVolunteerCounts
    assert.ok(typeof counts.membersOnly === 'number')
    assert.ok(typeof counts.volunteersOnly === 'number')
    assert.ok(typeof counts.both === 'number')
    assert.strictEqual(counts.total, counts.membersOnly + counts.volunteersOnly + counts.both)
  })
})

test('DumpChainData provider service counts', async (t) => {
  const data = DumpChainData.from(sampleCsv)

  await t.test('calculates provider counts from Requests History and Requests Confirmed', () => {
    const metroData = data.getMetroAreaData('Aquidneck')
    const counts = metroData.providerCounts
    assert.ok(Array.isArray(counts))
    if (counts.length > 0) {
      const sample = counts[0]
      assert.ok(sample.name, 'should have name')
      assert.ok(typeof sample.completed === 'number')
      assert.ok(typeof sample.confirmed === 'number')
    }
  })
})

test('DumpChainData member request counts', async (t) => {
  const data = DumpChainData.from(sampleCsv)

  await t.test('calculates member counts from all request types', () => {
    const metroData = data.getMetroAreaData('Aquidneck')
    const counts = metroData.memberCounts
    assert.ok(Array.isArray(counts))
    if (counts.length > 0) {
      const sample = counts[0]
      assert.ok(sample.name)
      assert.ok(typeof sample.open === 'number')
      assert.ok(typeof sample.confirmed === 'number')
      assert.ok(typeof sample.completed === 'number')
      assert.ok(typeof sample.unmatched === 'number')
    }
  })
})

test('DumpChainData category counts', async (t) => {
  const data = DumpChainData.from(sampleCsv)

  await t.test('counts volunteers per category', () => {
    const metroData = data.getMetroAreaData('Aquidneck')
    const counts = metroData.categoryCounts
    assert.ok(Array.isArray(counts))
    if (counts.length > 0) {
      const sample = counts[0]
      assert.ok(sample.name)
      assert.ok(typeof sample.count === 'number')
    }
  })
})

test('DumpChainData service name counts', async (t) => {
  const data = DumpChainData.from(sampleCsv)

  await t.test('counts requests by service name', () => {
    const metroData = data.getMetroAreaData('Aquidneck')
    const counts = metroData.serviceCounts
    assert.ok(Array.isArray(counts))
    if (counts.length > 0) {
      const sample = counts[0]
      assert.ok(sample.name)
      assert.ok(typeof sample.open === 'number')
    }
  })
})

test('DumpChainData metroAreas()', async (t) => {
  const data = DumpChainData.from(sampleCsv)

  await t.test('returns sorted list of all metro areas in CSV', () => {
    const areas = data.metroAreas()
    assert.ok(Array.isArray(areas))
    assert.ok(areas.length > 0)
    assert.deepStrictEqual(areas, [...areas].sort(), 'areas should be sorted')
  })
})
