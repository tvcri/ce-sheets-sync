import { parse } from 'csv-parse/sync'

function formatDateToISO(dateStr) {
  if (!dateStr || !dateStr.trim()) return ''

  const cleaned = dateStr.trim().replace(/^"|"$/g, '')
  const dateMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!dateMatch) return dateStr

  const month = dateMatch[1].padStart(2, '0')
  const day = dateMatch[2].padStart(2, '0')
  const year = dateMatch[3]

  const timeMatch = cleaned.match(/(\d{1,2}):(\d{2})\s(AM|PM)/)
  let time = ''
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10)
    const minutes = timeMatch[2]
    const period = timeMatch[3]
    if (period === 'PM' && hours !== 12) hours += 12
    if (period === 'AM' && hours === 12) hours = 0
    time = ` ${hours.toString().padStart(2, '0')}:${minutes}`
  }

  return `${year}-${month}-${day}${time}`
}

function convertToDisplayFormat(dateStr) {
  if (!dateStr || !dateStr.includes(':')) return dateStr
  const match = dateStr.match(/^(.+)\s(\d{2}):(\d{2})$/)
  if (!match) return dateStr
  const datePart = match[1]
  let hours = parseInt(match[2], 10)
  const minutes = match[3]
  const period = hours >= 12 ? 'PM' : 'AM'
  if (hours > 12) hours -= 12
  if (hours === 0) hours = 12
  return `${datePart} ${hours}:${minutes} ${period}`
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
  record['Created Date/Time'] = formatDateToISO(record['Created Date/Time'])
  record['Start Date/Time'] = formatDateToISO(record['Start Date/Time'])
  record['Finish Date/Time'] = formatDateToISO(record['Finish Date/Time'])
  return record
}

function formatServiceDatesForDisplay(record) {
  record['Created Date/Time'] = convertToDisplayFormat(record['Created Date/Time'])
  record['Start Date/Time'] = convertToDisplayFormat(record['Start Date/Time'])
  record['Finish Date/Time'] = convertToDisplayFormat(record['Finish Date/Time'])
  return record
}

function getMetroSectionWithDates(section, metroArea, dateFormatter = null) {
  const filtered = removeMetroAreaColumn(section.filter(r => r['Metro Area'] === metroArea))
  return dateFormatter ? filtered.map(dateFormatter) : filtered
}

function splitConfirmedByDate(records, now) {
  const isPast = c => {
    const finish = c['Finish Date/Time']
    if (!finish) return false
    const d = new Date(finish)
    return !isNaN(d) && d < now
  }
  return {
    past: records.filter(isPast).map(c => {
      c['Status'] = 'Past Confirmed'
      return c
    }),
    current: records.filter(c => !isPast(c))
  }
}

function hasMetroAreaData(parsed, metroArea) {
  // Check if metro area exists in any data section
  const sections = ['dump-member', 'dump-service-requested', 'dump-service-confirmed', 'dump-service-history', 'dump-service-provider']
  for (const section of sections) {
    if (parsed[section] && parsed[section].some(r => r['Metro Area'] === metroArea)) {
      return true
    }
  }
  return false
}

function getMetroAreaData(parsed, metroArea, asOf = new Date()) {
  // Get original CSV headers for history to use as key order reference
  const historyRaw = parsed['dump-service-history']
  const historyHeadersInOriginalOrder = historyRaw.length > 0 ? Object.keys(historyRaw[0]).filter(k => k !== 'Metro Area') : []

  const membersWithDates = getMetroSectionWithDates(parsed['dump-member'], metroArea, m => {
    m['Birthday'] = formatDateToISO(m['Birthday'])
    m['Join Date'] = formatDateToISO(m['Join Date'])
    return m
  })

  const requestsWithDates = getMetroSectionWithDates(parsed['dump-service-requested'], metroArea, formatServiceDates).map(formatServiceDatesForDisplay)

  const confirmedWithDates = getMetroSectionWithDates(parsed['dump-service-confirmed'], metroArea, formatServiceDates)

  const { past: pastConfirmedInHistory, current: currentConfirmed } = splitConfirmedByDate(confirmedWithDates, asOf)
  const currentConfirmedForDisplay = currentConfirmed.map(formatServiceDatesForDisplay)

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

  // Normalize key order using original CSV headers
  const normalizedHistory = allHistory.map(record => {
    const normalized = {}
    for (const key of historyHeadersInOriginalOrder) {
      if (key in record) {
        normalized[key] = record[key]
      }
    }
    // Add any extra keys not in headers (shouldn't happen, but be safe)
    for (const key of Object.keys(record)) {
      if (!(key in normalized)) {
        normalized[key] = record[key]
      }
    }
    return normalized
  })

  const historyForDisplay = normalizedHistory.map(formatServiceDatesForDisplay)

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
    'Requests Confirmed': currentConfirmedForDisplay,
    'Requests History': historyForDisplay
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
  const memberKeys = new Set(members.map(m => `${m['Metro Area']}:${m['Name']}`))
  const providerKeys = new Set(providers.map(p => `${p['Metro Area']}:${p['Name']}`))
  const allKeys = new Set([...memberKeys, ...providerKeys])

  let membersOnly = 0, volunteersOnly = 0, both = 0
  for (const key of allKeys) {
    const isMember = memberKeys.has(key)
    const isVolunteer = providerKeys.has(key)
    if (isMember && isVolunteer) both++
    else if (isMember) membersOnly++
    else volunteersOnly++
  }

  return { membersOnly, volunteersOnly, both, total: membersOnly + volunteersOnly + both }
}

export {
  formatDateToISO,
  convertToDisplayFormat,
  splitDumpChain,
  parseSection,
  flattenProviderCategories,
  removeMetroAreaColumn,
  parseDumpChain,
  hasMetroAreaData,
  getMetroAreaData,
  getProviderServiceCounts,
  getMemberRequestCounts,
  getProviderCategoryCounts,
  getServiceNameCounts,
  getMemberVolunteerCounts
}
