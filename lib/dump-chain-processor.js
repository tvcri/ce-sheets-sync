import { parse } from 'csv-parse/sync'

function formatDateToISO(dateStr) {
  if (!dateStr || !dateStr.trim()) return ''

  const cleaned = dateStr.trim().replace(/^"|"$/g, '')
  const dateMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!dateMatch) return dateStr

  const month = dateMatch[1].padStart(2, '0')
  const day = dateMatch[2].padStart(2, '0')
  const year = dateMatch[3]

  const timeMatch = cleaned.match(/(\d{1,2}:\d{2}\s(?:AM|PM))/)
  const time = timeMatch ? ' ' + timeMatch[1] : ''

  return `${year}-${month}-${day}${time}`
}

function splitDumpChain(csvContent) {
  const lines = csvContent.split('\n')
  const sections = {}
  let currentSection = null
  let currentLines = []

  for (const line of lines) {
    if (line.startsWith('"dump-')) {
      const match = line.match(/^"(dump-[^"]+)"/)
      if (match) {
        if (currentSection && currentLines.length > 0) {
          sections[currentSection] = currentLines.join('\n')
        }
        currentSection = match[1]
        currentLines = [line]
      }
    } else if (currentSection) {
      currentLines.push(line)
    }
  }

  if (currentSection && currentLines.length > 0) {
    sections[currentSection] = currentLines.join('\n')
  }

  return sections
}

function parseSection(csvText) {
  const lines = csvText.split('\n')
  const csvBody = lines.slice(1).join('\n').trim()

  const records = parse(csvBody, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true
  })

  return records
}

function flattenProviderCategories(providers, categories) {
  const filteredProviders = providers.filter(p => !p['Name'].startsWith('SRLog,'))
  const filteredCategories = categories.filter(c => !c['Name'].startsWith('SRLog,'))

  const categoryMap = {}
  for (const cat of filteredCategories) {
    const categoryKey = `${cat['Metro Area']}:${cat['Name']}`
    if (!categoryMap[categoryKey]) {
      categoryMap[categoryKey] = []
    }
    categoryMap[categoryKey].push(cat['Category'])
  }

  const allCategories = new Set()
  for (const cats of Object.values(categoryMap)) {
    cats.forEach(c => allCategories.add(c))
  }
  const categoryList = Array.from(allCategories).sort()

  const flattened = filteredProviders.map(provider => {
    const providerKey = `${provider['Metro Area']}:${provider['Name']}`
    const providerCats = categoryMap[providerKey] || []
    const record = { ...provider }

    for (const cat of categoryList) {
      let columnName = cat
      if (cat === 'Errands') columnName = 'Errand'
      if (cat === 'Rides') columnName = 'Ride'
      record[columnName] = providerCats.includes(cat) ? '✓' : ''
    }

    return record
  })

  return flattened
}

function removeMetroAreaColumn(records) {
  return records.map(record => {
    const { 'Metro Area': _, ...rest } = record
    return rest
  })
}

function parseDumpChain(csvContent) {
  const sections = splitDumpChain(csvContent)
  const parsed = {}

  for (const [sectionName, csvText] of Object.entries(sections)) {
    parsed[sectionName] = parseSection(csvText)
  }

  return parsed
}

function formatServiceDates(record) {
  return {
    ...record,
    'Created Date/Time': formatDateToISO(record['Created Date/Time']),
    'Start Date/Time': formatDateToISO(record['Start Date/Time']),
    'Finish Date/Time': formatDateToISO(record['Finish Date/Time'])
  }
}

function getMetroSectionWithDates(section, metroArea, dateFormatter = null) {
  const filtered = removeMetroAreaColumn(section.filter(r => r['Metro Area'] === metroArea))
  return dateFormatter ? filtered.map(dateFormatter) : filtered
}

function splitConfirmedByDate(records, cutoff) {
  const isPast = c => {
    const finish = c['Finish Date/Time']
    if (!finish) return false
    const d = new Date(finish)
    return !isNaN(d) && d < cutoff
  }
  return {
    past: records.filter(isPast).map(c => ({ ...c, 'Status': 'Past Confirmed' })),
    current: records.filter(c => !isPast(c))
  }
}

function getMetroAreaData(parsed, metroArea, asOf = new Date()) {
  const membersWithDates = getMetroSectionWithDates(parsed['dump-member'], metroArea, m => ({
    ...m,
    'Birthday': formatDateToISO(m['Birthday']),
    'Join Date': formatDateToISO(m['Join Date'])
  }))

  const requestsWithDates = getMetroSectionWithDates(parsed['dump-service-requested'], metroArea, formatServiceDates)

  const confirmedWithDates = getMetroSectionWithDates(parsed['dump-service-confirmed'], metroArea, formatServiceDates)

  const cutoff = new Date(asOf)
  cutoff.setHours(0, 0, 0, 0)
  const { past: pastConfirmedInHistory, current: currentConfirmed } = splitConfirmedByDate(confirmedWithDates, cutoff)

  const historyWithDates = getMetroSectionWithDates(
    parsed['dump-service-history'].filter(h => h['Service Name'] !== 'Member Added'),
    metroArea,
    formatServiceDates
  )

  const historyUnmatchedWithDates = parsed['dump-service-history-unmatched']
    ? getMetroSectionWithDates(
        parsed['dump-service-history-unmatched'].filter(h => h['Service Name'] !== 'Member Added'),
        metroArea,
        formatServiceDates
      )
    : []

  const allHistory = [...historyWithDates, ...historyUnmatchedWithDates, ...pastConfirmedInHistory].sort((a, b) => {
    const aDate = a['Finish Date/Time'] || ''
    const bDate = b['Finish Date/Time'] || ''
    return bDate.localeCompare(aDate)
  })

  const providers = parsed['dump-service-provider'].filter(p => p['Metro Area'] === metroArea)
  const categories = parsed['dump-service-provider-category'].filter(c => c['Metro Area'] === metroArea)
  const flatProviders = flattenProviderCategories(providers, categories)
  const cleanProviders = removeMetroAreaColumn(flatProviders)
  const providersWithDates = cleanProviders.map(p => ({
    ...p,
    'Join Date': formatDateToISO(p['Join Date'])
  }))

  return {
    Members: membersWithDates,
    Volunteers: providersWithDates,
    'Requests Open': requestsWithDates,
    'Requests Confirmed': currentConfirmed,
    'Requests History': allHistory
  }
}

function getProviderServiceCounts(historyRecords, confirmedRecords = []) {
  const providerCounts = {}

  for (const record of historyRecords) {
    const volunteerName = record['Volunteer'] || ''
    const status = (record['Status'] || '').trim().toLowerCase()
    if (volunteerName.trim() && volunteerName !== 'Cancelled' && (status === 'completed' || status === 'past confirmed')) {
      if (!providerCounts[volunteerName]) {
        providerCounts[volunteerName] = { completed: 0, confirmed: 0 }
      }
      providerCounts[volunteerName].completed += 1
    }
  }

  for (const record of confirmedRecords) {
    const volunteerName = record['Volunteer'] || ''
    if (volunteerName.trim() && volunteerName !== 'Cancelled') {
      if (!providerCounts[volunteerName]) {
        providerCounts[volunteerName] = { completed: 0, confirmed: 0 }
      }
      providerCounts[volunteerName].confirmed += 1
    }
  }

  return Object.entries(providerCounts)
    .map(([name, counts]) => ({ name, completed: counts.completed, confirmed: counts.confirmed }))
    .sort((a, b) => (b.completed + b.confirmed) - (a.completed + a.confirmed))
}

function countByField(fieldName, openRecords = [], confirmedRecords = [], historyRecords = []) {
  const counts = {}

  for (const record of openRecords) {
    const name = record[fieldName] || ''
    if (name.trim()) {
      if (!counts[name]) {
        counts[name] = { open: 0, confirmed: 0, completed: 0, unmatched: 0, cancelled: 0 }
      }
      counts[name].open += 1
    }
  }

  for (const record of confirmedRecords) {
    const name = record[fieldName] || ''
    if (name.trim()) {
      if (!counts[name]) {
        counts[name] = { open: 0, confirmed: 0, completed: 0, unmatched: 0, cancelled: 0 }
      }
      counts[name].confirmed += 1
    }
  }

  for (const record of historyRecords) {
    const name = record[fieldName] || ''
    if (name.trim()) {
      if (!counts[name]) {
        counts[name] = { open: 0, confirmed: 0, completed: 0, unmatched: 0, cancelled: 0 }
      }
      const status = record['Status'] || ''
      const statusLower = status.trim().toLowerCase()
      if (statusLower === 'unmatched') {
        counts[name].unmatched += 1
      } else if (statusLower === 'completed' || statusLower === 'past confirmed') {
        counts[name].completed += 1
      } else {
        counts[name].cancelled += 1
      }
    }
  }

  return Object.entries(counts)
    .map(([name, count]) => ({ name, open: count.open, confirmed: count.confirmed, completed: count.completed, unmatched: count.unmatched, cancelled: count.cancelled }))
    .sort((a, b) => (b.open + b.confirmed + b.completed + b.unmatched + b.cancelled) - (a.open + a.confirmed + a.completed + a.unmatched + a.cancelled))
}

function getMemberRequestCounts(openRecords = [], confirmedRecords = [], historyRecords = []) {
  return countByField('Member', openRecords, confirmedRecords, historyRecords)
}

function getProviderCategoryCounts(categoryRecords = []) {
  const categoryCounts = {
    'Errands': 0,
    'Home Help': 0,
    'Rides': 0,
    'Tech Support': 0
  }

  const seen = new Set()
  for (const record of categoryRecords) {
    const providerName = record['Name'] || ''
    const category = record['Category'] || ''
    if (providerName.trim() && category.trim() && !providerName.startsWith('SRLog,')) {
      const key = `${providerName}:${category}`
      if (!seen.has(key)) {
        seen.add(key)
        if (categoryCounts.hasOwnProperty(category)) {
          categoryCounts[category] += 1
        }
      }
    }
  }

  return Object.entries(categoryCounts)
    .map(([name, count]) => ({ name, count }))
}

function getServiceNameCounts(openRecords = [], confirmedRecords = [], historyRecords = []) {
  return countByField('Service Name', openRecords, confirmedRecords, historyRecords)
}

function getMemberVolunteerCounts(members = [], providers = []) {
  // Create keys for members (Metro Area:Name) and track member status
  const memberMap = new Map()
  for (const member of members) {
    const key = `${member['Metro Area']}:${member['Name']}`
    const isVolunteer = member['Is volunteer']?.trim().toLowerCase() === 'yes'
    memberMap.set(key, { isVolunteer, isMember: true })
  }

  // Enrich with provider data (IsMember field from dump-service-provider)
  for (const provider of providers) {
    const key = `${provider['Metro Area']}:${provider['Name']}`
    const isMemberInProvider = provider['IsMember']?.trim().toLowerCase() === 'true'

    if (memberMap.has(key)) {
      // Already in members, update based on provider data
      const existing = memberMap.get(key)
      existing.isMember = existing.isMember || isMemberInProvider
      existing.isVolunteer = existing.isVolunteer || true // in providers = is volunteer
    } else {
      // Only in providers — being in providers means they are a volunteer
      memberMap.set(key, { isVolunteer: true, isMember: isMemberInProvider })
    }
  }

  // Count the categories
  let membersOnly = 0
  let volunteersOnly = 0
  let both = 0

  for (const { isVolunteer, isMember } of memberMap.values()) {
    if (isMember && isVolunteer) {
      both += 1
    } else if (isMember) {
      membersOnly += 1
    } else if (isVolunteer) {
      volunteersOnly += 1
    }
  }

  return {
    membersOnly,
    volunteersOnly,
    both,
    total: membersOnly + volunteersOnly + both
  }
}

export {
  formatDateToISO,
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
}
