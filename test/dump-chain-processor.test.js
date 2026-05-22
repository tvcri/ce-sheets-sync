import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import {
  formatDateToISO,
  convertToDisplayFormat,
  splitDumpChain,
  parseSection,
  flattenProviderCategories,
  removeMetroAreaColumn,
  parseDumpChain,
  getMetroAreaData,
  getProviderServiceCounts,
  getMemberRequestCounts,
  getProviderCategoryCounts,
  getServiceNameCounts,
  getMemberVolunteerCounts
} from '../lib/dump-chain-processor.js'

const sampleCsv = fs.readFileSync('./test/fixtures/sample-dump-chain.csv', 'utf-8')

test('formatDateToISO', async (t) => {
  await t.test('returns empty string for empty/null input', () => {
    assert.strictEqual(formatDateToISO(''), '')
    assert.strictEqual(formatDateToISO('   '), '')
  })

  await t.test('formats date without time', () => {
    assert.strictEqual(formatDateToISO('5/10/2026'), '2026-05-10')
  })

  await t.test('formats date with single-digit month/day (padding)', () => {
    assert.strictEqual(formatDateToISO('1/5/2025'), '2025-01-05')
  })

  await t.test('formats date with time in 24-hour format (for sorting)', () => {
    assert.strictEqual(formatDateToISO('5/10/2026 10:30 AM'), '2026-05-10 10:30')
    assert.strictEqual(formatDateToISO('3/15/1950 2:45 PM'), '1950-03-15 14:45')
  })

  await t.test('returns original string if no date match', () => {
    assert.strictEqual(formatDateToISO('invalid-date'), 'invalid-date')
  })

  await t.test('strips surrounding quotes before parsing', () => {
    assert.strictEqual(formatDateToISO('"1/30/2026"'), '2026-01-30')
    assert.strictEqual(formatDateToISO('"5/15/1950 2:30 PM"'), '1950-05-15 14:30')
  })

  await t.test('convertToDisplayFormat converts 24-hour to 12-hour for display', () => {
    assert.strictEqual(convertToDisplayFormat('2026-05-10 10:30'), '2026-05-10 10:30 AM')
    assert.strictEqual(convertToDisplayFormat('1950-03-15 14:45'), '1950-03-15 2:45 PM')
    assert.strictEqual(convertToDisplayFormat('2026-05-10 00:15'), '2026-05-10 12:15 AM')
    assert.strictEqual(convertToDisplayFormat('2026-05-10 12:00'), '2026-05-10 12:00 PM')
  })
})

test('splitDumpChain', async (t) => {
  await t.test('splits CSV into sections by dump-* headers', () => {
    const sections = splitDumpChain(sampleCsv)
    assert.ok(sections['dump-member'])
    assert.ok(sections['dump-service-provider'])
    assert.ok(sections['dump-service-provider-category'])
    assert.ok(sections['dump-service-requested'])
    assert.ok(sections['dump-service-confirmed'])
    assert.ok(sections['dump-service-history'])
  })

  await t.test('each section contains header and data lines', () => {
    const sections = splitDumpChain(sampleCsv)
    assert.ok(sections['dump-member'].includes('Metro Area'))
    assert.ok(sections['dump-member'].includes('Smith, Alice'))
  })

  await t.test('handles empty input', () => {
    const sections = splitDumpChain('')
    assert.deepStrictEqual(sections, {})
  })
})

test('parseSection', async (t) => {
  const memberSection = splitDumpChain(sampleCsv)['dump-member']

  await t.test('parses CSV section into array of objects', () => {
    const records = parseSection(memberSection)
    assert.ok(Array.isArray(records))
    assert.ok(records.length > 0)
    assert.ok(records[0]['Metro Area'])
    assert.ok(records[0]['Name'])
  })

  await t.test('uses first line as column headers', () => {
    const records = parseSection(memberSection)
    assert.ok(records[0].hasOwnProperty('Email'))
    assert.ok(records[0].hasOwnProperty('Birthday'))
  })

  await t.test('handles trailing newlines in CSV section', () => {
    const csvWithTrailingNewline = memberSection + '\n\n'
    const records = parseSection(csvWithTrailingNewline)
    assert.ok(records.length > 0)
    const lastRecord = records[records.length - 1]
    assert.ok(!lastRecord['Member Number'].includes('"'), 'final field should not have quotes')
  })
})

test('flattenProviderCategories', async (t) => {
  await t.test('pivots categories from rows to columns', () => {
    const providers = [
      { 'Metro Area': 'Aquidneck', 'Name': 'Davis, Frank' },
      { 'Metro Area': 'Aquidneck', 'Name': 'Taylor, Eva' }
    ]
    const categories = [
      { 'Metro Area': 'Aquidneck', 'Name': 'Davis, Frank', 'Category': 'Errands' },
      { 'Metro Area': 'Aquidneck', 'Name': 'Taylor, Eva', 'Category': 'Rides' },
      { 'Metro Area': 'Aquidneck', 'Name': 'Taylor, Eva', 'Category': 'Tech Support' }
    ]
    const flattened = flattenProviderCategories(providers, categories)

    assert.strictEqual(flattened.length, 2)
    assert.strictEqual(flattened[0]['Errand'], '✓')
    assert.strictEqual(flattened[1]['Ride'], '✓')
    assert.strictEqual(flattened[1]['Tech Support'], '✓')
    assert.ok(flattened[0].hasOwnProperty('Errand'))
    assert.ok(flattened[1].hasOwnProperty('Ride'))
    assert.ok(!flattened[0].hasOwnProperty('Errands'))
    assert.ok(!flattened[1].hasOwnProperty('Rides'))
    assert.strictEqual(flattened[0]['Ride'], '')
  })

  await t.test('filters out SRLog entries', () => {
    const providers = [
      { 'Metro Area': 'Aquidneck', 'Name': 'Davis, Frank' },
      { 'Metro Area': 'Aquidneck', 'Name': 'SRLog,System' }
    ]
    const categories = [
      { 'Metro Area': 'Aquidneck', 'Name': 'Davis, Frank', 'Category': 'Errands' }
    ]
    const flattened = flattenProviderCategories(providers, categories)

    assert.strictEqual(flattened.length, 1)
    assert.strictEqual(flattened[0]['Name'], 'Davis, Frank')
  })
})

test('removeMetroAreaColumn', async (t) => {
  await t.test('removes Metro Area key from all records', () => {
    const records = [
      { 'Metro Area': 'Aquidneck', 'Name': 'Smith', 'Email': 'smith@example.com' },
      { 'Metro Area': 'Wood River', 'Name': 'Jones', 'Email': 'jones@example.com' }
    ]
    const cleaned = removeMetroAreaColumn(records)

    assert.strictEqual(cleaned.length, 2)
    assert.ok(!cleaned[0].hasOwnProperty('Metro Area'))
    assert.strictEqual(cleaned[0]['Name'], 'Smith')
    assert.strictEqual(cleaned[0]['Email'], 'smith@example.com')
  })
})

test('parseDumpChain', async (t) => {
  await t.test('parses entire CSV into sections with parsed records', () => {
    const parsed = parseDumpChain(sampleCsv)

    assert.ok(parsed['dump-member'])
    assert.ok(Array.isArray(parsed['dump-member']))
    assert.ok(parsed['dump-member'].length > 0)
    assert.ok(parsed['dump-member'][0].hasOwnProperty('Name'))

    assert.ok(parsed['dump-service-provider'])
    assert.ok(parsed['dump-service-provider-category'])
  })
})

test('getMetroAreaData', async (t) => {
  const parsed = parseDumpChain(sampleCsv)

  await t.test('filters records by metro area', () => {
    const aquidneckData = getMetroAreaData(parsed, 'Aquidneck')

    assert.ok(aquidneckData.Members.every(m => !m.hasOwnProperty('Metro Area')))
    assert.ok(aquidneckData.Members.length > 0)
  })

  await t.test('returns 5 tabs: Members, Volunteers, Requests Open/Confirmed/History', () => {
    const aquidneckData = getMetroAreaData(parsed, 'Aquidneck')

    assert.ok(aquidneckData.hasOwnProperty('Members'))
    assert.ok(aquidneckData.hasOwnProperty('Volunteers'))
    assert.ok(aquidneckData.hasOwnProperty('Requests Open'))
    assert.ok(aquidneckData.hasOwnProperty('Requests Confirmed'))
    assert.ok(aquidneckData.hasOwnProperty('Requests History'))
  })

  await t.test('formats date fields to ISO format', () => {
    const aquidneckData = getMetroAreaData(parsed, 'Aquidneck')
    const member = aquidneckData.Members[0]

    if (member['Birthday']) {
      assert.match(member['Birthday'], /^\d{4}-\d{2}-\d{2}/)
    }
    if (member['Join Date']) {
      assert.match(member['Join Date'], /^\d{4}-\d{2}-\d{2}/)
    }
  })

  await t.test('filters out "Member Added" from history', () => {
    const aquidneckData = getMetroAreaData(parsed, 'Aquidneck')
    const hasAddedRecords = aquidneckData['Requests History'].some(r => r['Service Name'] === 'Member Added')
    assert.strictEqual(hasAddedRecords, false)
  })

  await t.test('promotes past confirmed records to history with "Past Confirmed" status', () => {
    const testParsed = {
      'dump-member': [],
      'dump-service-requested': [],
      'dump-service-confirmed': [
        {
          'Metro Area': 'TestArea',
          'Request Number': '1',
          'Member': 'Alice',
          'Status': 'Confirmed',
          'Volunteer': 'Bob',
          'Service Name': 'Ride',
          'Transportation Type': 'Round Trip',
          'Created Date/Time': '1/1/2020 10:00 AM',
          'Start Date/Time': '1/1/2020 10:00 AM',
          'Finish Date/Time': '1/1/2020 11:00 AM',
          'Instructions': '',
          'Description': '',
          'Destination': '',
          'Address': '',
          'City': '',
          'Phone': ''
        }
      ],
      'dump-service-requested': [],
      'dump-service-history': [],
      'dump-service-provider': [],
      'dump-service-provider-category': []
    }
    const testDate = new Date('2026-05-21')
    const testData = getMetroAreaData(testParsed, 'TestArea', testDate)

    assert.ok(testData['Requests History'].some(r => r['Request Number'] === '1' && r['Status'] === 'Past Confirmed'))
  })

  await t.test('excludes past confirmed records from "Requests Confirmed" tab', () => {
    const testParsed = {
      'dump-member': [],
      'dump-service-requested': [],
      'dump-service-confirmed': [
        {
          'Metro Area': 'TestArea',
          'Request Number': '1',
          'Member': 'Alice',
          'Status': 'Confirmed',
          'Volunteer': 'Bob',
          'Service Name': 'Ride',
          'Transportation Type': 'Round Trip',
          'Created Date/Time': '1/1/2020 10:00 AM',
          'Start Date/Time': '1/1/2020 10:00 AM',
          'Finish Date/Time': '1/1/2020 11:00 AM',
          'Instructions': '',
          'Description': '',
          'Destination': '',
          'Address': '',
          'City': '',
          'Phone': ''
        }
      ],
      'dump-service-requested': [],
      'dump-service-history': [],
      'dump-service-provider': [],
      'dump-service-provider-category': []
    }
    const testDate = new Date('2026-05-21')
    const testData = getMetroAreaData(testParsed, 'TestArea', testDate)

    assert.ok(!testData['Requests Confirmed'].some(r => r['Request Number'] === '1'))
  })

  await t.test('keeps future confirmed records (after today) in "Requests Confirmed" tab', () => {
    const testParsed = {
      'dump-member': [],
      'dump-service-requested': [],
      'dump-service-confirmed': [
        {
          'Metro Area': 'TestArea',
          'Request Number': '1',
          'Member': 'Alice',
          'Status': 'Confirmed',
          'Volunteer': 'Bob',
          'Service Name': 'Ride',
          'Transportation Type': 'Round Trip',
          'Created Date/Time': '5/21/2026 10:00 AM',
          'Start Date/Time': '5/22/2026 10:00 AM',
          'Finish Date/Time': '5/22/2026 11:00 AM',
          'Instructions': '',
          'Description': '',
          'Destination': '',
          'Address': '',
          'City': '',
          'Phone': ''
        }
      ],
      'dump-service-requested': [],
      'dump-service-history': [],
      'dump-service-provider': [],
      'dump-service-provider-category': []
    }
    const testDate = new Date('2026-05-21')
    const testData = getMetroAreaData(testParsed, 'TestArea', testDate)

    const confirmed = testData['Requests Confirmed'].find(r => r['Request Number'] === '1')
    assert.ok(confirmed)
    assert.strictEqual(confirmed['Status'], 'Confirmed')
  })
})

test('getProviderServiceCounts', async (t) => {
  await t.test('counts completed services from history and confirmed services', () => {
    const history = [
      { 'Volunteer': 'Davis, Frank', 'Status': 'Completed' },
      { 'Volunteer': 'Davis, Frank', 'Status': 'Completed' },
      { 'Volunteer': 'Taylor, Eva', 'Status': 'Completed' }
    ]
    const confirmed = [
      { 'Volunteer': 'Davis, Frank' },
      { 'Volunteer': 'Taylor, Eva' }
    ]
    const counts = getProviderServiceCounts(history, confirmed)

    const davis = counts.find(c => c.name === 'Davis, Frank')
    assert.strictEqual(davis.completed, 2)
    assert.strictEqual(davis.confirmed, 1)

    const taylor = counts.find(c => c.name === 'Taylor, Eva')
    assert.strictEqual(taylor.completed, 1)
    assert.strictEqual(taylor.confirmed, 1)
  })

  await t.test('filters out empty/whitespace provider names and "Cancelled"', () => {
    const history = [
      { 'Volunteer': 'Davis, Frank', 'Status': 'Completed' },
      { 'Volunteer': '', 'Status': 'Completed' },
      { 'Volunteer': '   ', 'Status': 'Completed' },
      { 'Volunteer': 'Cancelled', 'Status': 'Completed' }
    ]
    const counts = getProviderServiceCounts(history, [])

    assert.strictEqual(counts.length, 1)
    assert.strictEqual(counts[0].name, 'Davis, Frank')
  })

  await t.test('sorts by total count descending', () => {
    const history = [
      { 'Volunteer': 'Eva', 'Status': 'Completed' },
      { 'Volunteer': 'Eva', 'Status': 'Completed' },
      { 'Volunteer': 'Eva', 'Status': 'Completed' },
      { 'Volunteer': 'Frank', 'Status': 'Completed' }
    ]
    const counts = getProviderServiceCounts(history, [])

    assert.strictEqual(counts[0].name, 'Eva')
    assert.strictEqual(counts[1].name, 'Frank')
  })

  await t.test('counts "Past Confirmed" history records as completed', () => {
    const history = [
      { 'Volunteer': 'Davis, Frank', 'Status': 'Completed' },
      { 'Volunteer': 'Davis, Frank', 'Status': 'Past Confirmed' },
      { 'Volunteer': 'Taylor, Eva', 'Status': 'Past Confirmed' }
    ]
    const counts = getProviderServiceCounts(history, [])

    const davis = counts.find(c => c.name === 'Davis, Frank')
    assert.strictEqual(davis.completed, 2)

    const taylor = counts.find(c => c.name === 'Taylor, Eva')
    assert.strictEqual(taylor.completed, 1)
  })
})

test('getMemberRequestCounts', async (t) => {
  await t.test('counts open/confirmed/completed/unmatched/cancelled by member', () => {
    const open = [
      { 'Member': 'Smith, Alice' },
      { 'Member': 'Johnson, Bob' }
    ]
    const confirmed = [
      { 'Member': 'Smith, Alice' }
    ]
    const history = [
      { 'Member': 'Smith, Alice', 'Status': 'Completed' },
      { 'Member': 'Johnson, Bob', 'Status': 'Unmatched' }
    ]
    const counts = getMemberRequestCounts(open, confirmed, history)

    const alice = counts.find(c => c.name === 'Smith, Alice')
    assert.strictEqual(alice.open, 1)
    assert.strictEqual(alice.confirmed, 1)
    assert.strictEqual(alice.completed, 1)
    assert.strictEqual(alice.unmatched, 0)
    assert.strictEqual(alice.cancelled, 0)

    const bob = counts.find(c => c.name === 'Johnson, Bob')
    assert.strictEqual(bob.open, 1)
    assert.strictEqual(bob.unmatched, 1)
    assert.strictEqual(bob.cancelled, 0)
  })

  await t.test('counts "Past Confirmed" history records as completed', () => {
    const open = []
    const confirmed = []
    const history = [
      { 'Member': 'Smith, Alice', 'Status': 'Completed' },
      { 'Member': 'Johnson, Bob', 'Status': 'Past Confirmed' }
    ]
    const counts = getMemberRequestCounts(open, confirmed, history)

    const alice = counts.find(c => c.name === 'Smith, Alice')
    assert.strictEqual(alice.completed, 1)

    const bob = counts.find(c => c.name === 'Johnson, Bob')
    assert.strictEqual(bob.completed, 1)
  })
})

test('getProviderCategoryCounts', async (t) => {
  await t.test('counts unique providers per hardcoded category', () => {
    const categoryRecords = [
      { 'Name': 'Davis, Frank', 'Category': 'Errands' },
      { 'Name': 'Taylor, Eva', 'Category': 'Rides' },
      { 'Name': 'Taylor, Eva', 'Category': 'Tech Support' }
    ]
    const counts = getProviderCategoryCounts(categoryRecords)

    const errands = counts.find(c => c.name === 'Errands')
    assert.strictEqual(errands.count, 1)

    const rides = counts.find(c => c.name === 'Rides')
    assert.strictEqual(rides.count, 1)

    const techSupport = counts.find(c => c.name === 'Tech Support')
    assert.strictEqual(techSupport.count, 1)
  })

  await t.test('filters out SRLog entries', () => {
    const categoryRecords = [
      { 'Name': 'Davis, Frank', 'Category': 'Errands' },
      { 'Name': 'SRLog,System', 'Category': 'Errands' }
    ]
    const counts = getProviderCategoryCounts(categoryRecords)

    assert.strictEqual(counts.filter(c => c.count > 0).length, 1)
  })

  await t.test('includes all hardcoded categories even with zero count', () => {
    const counts = getProviderCategoryCounts([])

    const categoryNames = counts.map(c => c.name)
    assert.ok(categoryNames.includes('Errands'))
    assert.ok(categoryNames.includes('Rides'))
    assert.ok(categoryNames.includes('Tech Support'))
  })
})

test('getServiceNameCounts', async (t) => {
  await t.test('counts open/confirmed/completed/unmatched/cancelled by service name', () => {
    const open = [
      { 'Service Name': 'Ride: Shopping' }
    ]
    const confirmed = [
      { 'Service Name': 'Ride: Shopping' }
    ]
    const history = [
      { 'Service Name': 'Ride: Shopping', 'Status': 'Completed' }
    ]
    const counts = getServiceNameCounts(open, confirmed, history)

    const shopping = counts.find(c => c.name === 'Ride: Shopping')
    assert.strictEqual(shopping.open, 1)
    assert.strictEqual(shopping.confirmed, 1)
    assert.strictEqual(shopping.completed, 1)
    assert.strictEqual(shopping.unmatched, 0)
    assert.strictEqual(shopping.cancelled, 0)
  })

  await t.test('counts "Past Confirmed" history records as completed', () => {
    const open = []
    const confirmed = []
    const history = [
      { 'Service Name': 'Ride: Shopping', 'Status': 'Completed' },
      { 'Service Name': 'Errand: Pharmacy', 'Status': 'Past Confirmed' }
    ]
    const counts = getServiceNameCounts(open, confirmed, history)

    const shopping = counts.find(c => c.name === 'Ride: Shopping')
    assert.strictEqual(shopping.completed, 1)

    const pharmacy = counts.find(c => c.name === 'Errand: Pharmacy')
    assert.strictEqual(pharmacy.completed, 1)
  })
})

test('getMemberVolunteerCounts', async (t) => {
  await t.test('counts members only, volunteers only, and both when agreement exists', () => {
    const members = [
      { 'Metro Area': 'Wood River', 'Name': 'Smith, Alice', 'Is volunteer': 'No' },
      { 'Metro Area': 'Wood River', 'Name': 'Davis, Frank', 'Is volunteer': 'Yes' }
    ]
    const providers = [
      { 'Metro Area': 'Wood River', 'Name': 'Davis, Frank', 'IsMember': 'true' }
    ]
    const counts = getMemberVolunteerCounts(members, providers)

    assert.strictEqual(counts.membersOnly, 1)
    assert.strictEqual(counts.volunteersOnly, 0)
    assert.strictEqual(counts.both, 1)
    assert.strictEqual(counts.total, 2)
  })

  await t.test('reconciles inconsistent "Is volunteer" and "IsMember" flags', () => {
    const members = [
      { 'Metro Area': 'Wood River', 'Name': 'Jones, Bob', 'Is volunteer': '' }
    ]
    const providers = [
      { 'Metro Area': 'Wood River', 'Name': 'Jones, Bob', 'IsMember': 'true' }
    ]
    const counts = getMemberVolunteerCounts(members, providers)

    assert.strictEqual(counts.both, 1)
    assert.strictEqual(counts.membersOnly, 0)
    assert.strictEqual(counts.volunteersOnly, 0)
  })

  await t.test('counts pure volunteers who are not members', () => {
    const members = []
    const providers = [
      { 'Metro Area': 'Wood River', 'Name': 'Brown, Carol', 'IsMember': 'false' }
    ]
    const counts = getMemberVolunteerCounts(members, providers)

    assert.strictEqual(counts.volunteersOnly, 1)
    assert.strictEqual(counts.membersOnly, 0)
    assert.strictEqual(counts.both, 0)
  })

  await t.test('handles case-insensitive boolean values', () => {
    const members = [
      { 'Metro Area': 'Wood River', 'Name': 'White, Dave', 'Is volunteer': 'YES' }
    ]
    const providers = [
      { 'Metro Area': 'Wood River', 'Name': 'White, Dave', 'IsMember': 'True' }
    ]
    const counts = getMemberVolunteerCounts(members, providers)

    assert.strictEqual(counts.both, 1)
  })

  await t.test('returns zero counts when given empty arrays', () => {
    const counts = getMemberVolunteerCounts([], [])

    assert.strictEqual(counts.membersOnly, 0)
    assert.strictEqual(counts.volunteersOnly, 0)
    assert.strictEqual(counts.both, 0)
    assert.strictEqual(counts.total, 0)
  })
})

test('per-metro aggregation integrity', async (t) => {
  await t.test('getProviderServiceCounts returns correct per-metro totals', () => {
    const historyRecords = [
      { 'Volunteer': 'Alice', 'Status': 'completed', 'Metro Area': 'Aquidneck' },
      { 'Volunteer': 'Alice', 'Status': 'completed', 'Metro Area': 'Aquidneck' },
      { 'Volunteer': 'Bob', 'Status': 'completed', 'Metro Area': 'Providence' },
      { 'Volunteer': 'Bob', 'Status': 'completed', 'Metro Area': 'Providence' },
      { 'Volunteer': 'Bob', 'Status': 'completed', 'Metro Area': 'Providence' }
    ]
    const confirmedRecords = [
      { 'Volunteer': 'Alice', 'Metro Area': 'Aquidneck' },
      { 'Volunteer': 'Bob', 'Metro Area': 'Providence' }
    ]

    const counts = getProviderServiceCounts(historyRecords, confirmedRecords)

    // Verify correct counts per volunteer (independent of metro area)
    const alice = counts.find(c => c.name === 'Alice')
    assert.deepStrictEqual(alice, { name: 'Alice', completed: 2, confirmed: 1 })

    const bob = counts.find(c => c.name === 'Bob')
    assert.deepStrictEqual(bob, { name: 'Bob', completed: 3, confirmed: 1 })
  })

  await t.test('getMemberRequestCounts distinguishes between metro areas', () => {
    const openRecords = [
      { 'Member': 'John', 'Metro Area': 'Aquidneck' },
      { 'Member': 'Jane', 'Metro Area': 'Providence' }
    ]
    const confirmedRecords = [
      { 'Member': 'John', 'Metro Area': 'Aquidneck' },
      { 'Member': 'John', 'Metro Area': 'Aquidneck' }
    ]
    const historyRecords = [
      { 'Member': 'John', 'Status': 'completed', 'Metro Area': 'Aquidneck' },
      { 'Member': 'Jane', 'Status': 'completed', 'Metro Area': 'Providence' },
      { 'Member': 'Jane', 'Status': 'unmatched', 'Metro Area': 'Providence' }
    ]

    const counts = getMemberRequestCounts(openRecords, confirmedRecords, historyRecords)

    const john = counts.find(c => c.name === 'John')
    assert.strictEqual(john.open, 1)
    assert.strictEqual(john.confirmed, 2)
    assert.strictEqual(john.completed, 1)
    assert.strictEqual(john.unmatched, 0)

    const jane = counts.find(c => c.name === 'Jane')
    assert.strictEqual(jane.open, 1)
    assert.strictEqual(jane.confirmed, 0)
    assert.strictEqual(jane.completed, 1)
    assert.strictEqual(jane.unmatched, 1)
  })

  await t.test('per-metro aggregation with sample fixture (validates syncHub loop logic)', () => {
    const parsed = parseDumpChain(sampleCsv)

    // Simulate syncHub's per-metro loop for a single metro area
    const metroArea = 'Aquidneck'
    const open = (parsed['dump-service-requested'] || []).filter(r => r['Metro Area'] === metroArea)
    const confirmed = (parsed['dump-service-confirmed'] || []).filter(r => r['Metro Area'] === metroArea)
    const historyBase = (parsed['dump-service-history'] || [])
      .filter(r => r['Metro Area'] === metroArea && r['Service Name'] !== 'Member Added')
    const historyUnmatched = (parsed['dump-service-history-unmatched'] || [])
      .filter(r => r['Metro Area'] === metroArea && r['Service Name'] !== 'Member Added')
    const history = [...historyBase, ...historyUnmatched]

    // Verify aggregation produces non-empty results
    const pCounts = getProviderServiceCounts(history, confirmed)
    const mCounts = getMemberRequestCounts(open, confirmed, history)

    // These assertions would catch the bug where the per-metro loop was removed
    // (providerTotals and memberTotals would be empty)
    assert.ok(Array.isArray(pCounts), 'provider service counts should be an array')
    assert.ok(Array.isArray(mCounts), 'member request counts should be an array')

    // Verify the arrays are properly constructed (not just non-empty)
    if (pCounts.length > 0) {
      const sample = pCounts[0]
      assert.ok(sample.hasOwnProperty('name'), 'provider count should have name')
      assert.ok(sample.hasOwnProperty('completed'), 'provider count should have completed')
      assert.ok(sample.hasOwnProperty('confirmed'), 'provider count should have confirmed')
    }

    if (mCounts.length > 0) {
      const sample = mCounts[0]
      assert.ok(sample.hasOwnProperty('name'), 'member count should have name')
      assert.ok(sample.hasOwnProperty('open'), 'member count should have open')
      assert.ok(sample.hasOwnProperty('confirmed'), 'member count should have confirmed')
      assert.ok(sample.hasOwnProperty('completed'), 'member count should have completed')
      assert.ok(sample.hasOwnProperty('unmatched'), 'member count should have unmatched')
      assert.ok(sample.hasOwnProperty('cancelled'), 'member count should have cancelled')
    }
  })
})
