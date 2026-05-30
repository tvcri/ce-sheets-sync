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

const SERVICE_DATE_FIELDS = ['Created Date/Time', 'Start Date/Time', 'Finish Date/Time']

function applyToServiceDates(record, fn) {
  for (const field of SERVICE_DATE_FIELDS) {
    record[field] = fn(record[field])
  }
  return record
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

function getMetroSectionWithDates(section, metroArea, dateFormatter) {
  return removeMetroAreaColumn(section.filter(r => r['Metro Area'] === metroArea)).map(dateFormatter)
}

function splitConfirmedByDate(records, now) {
  const past = []
  const current = []
  for (const c of records) {
    const finish = c['Finish Date/Time']
    const d = new Date(finish)
    if (finish && !isNaN(d) && d < now) {
      past.push({ ...c, Status: 'Past Confirmed' })
    } else {
      current.push(c)
    }
  }
  return { past, current }
}

// pastConfirmed records come from dump-service-confirmed and may have a different JS object
// key order than dump-service-history records. If a past-confirmed record sorts first, the
// Sheets sync would write column headers in confirmed field order, breaking sheet layout.
// Normalize all merged records to history field order.
function mergeAndNormalizeHistory(historyWithDates, historyUnmatchedWithDates, pastConfirmed, headerKeys) {
  const merged = [...historyWithDates, ...historyUnmatchedWithDates, ...pastConfirmed]
    .sort((a, b) => (b['Finish Date/Time'] || '').localeCompare(a['Finish Date/Time'] || ''))

  return merged.map(record => {
    const normalized = {}
    for (const key of headerKeys) {
      if (key in record) {
        normalized[key] = record[key]
      }
    }
    for (const key of Object.keys(record)) {
      if (!(key in normalized)) {
        normalized[key] = record[key]
      }
    }
    return normalized
  })
}

// parsed must be the object returned by parseDumpChain(), with keys like 'dump-member', 'dump-service-history', etc.
function hasMetroAreaData(parsed, metroArea) {
  const sections = ['dump-member', 'dump-service-requested', 'dump-service-confirmed', 'dump-service-history', 'dump-service-provider']
  for (const section of sections) {
    if (parsed[section] && parsed[section].some(r => r['Metro Area'] === metroArea)) {
      return true
    }
  }
  return false
}

function getMetroAreaData(parsed, metroArea, asOf = new Date()) {
  const historyRaw = parsed['dump-service-history']
  const historyHeadersInOriginalOrder = historyRaw.length > 0 ? Object.keys(historyRaw[0]).filter(k => k !== 'Metro Area') : []

  const membersWithDates = getMetroSectionWithDates(parsed['dump-member'], metroArea, m => {
    m['Birthday'] = formatDateToISO(m['Birthday'])
    m['Join Date'] = formatDateToISO(m['Join Date'])
    return m
  })

  const requestsWithDates = getMetroSectionWithDates(parsed['dump-service-requested'], metroArea, r => applyToServiceDates(r, formatDateToISO)).map(r => applyToServiceDates(r, convertToDisplayFormat))

  const confirmedWithDates = getMetroSectionWithDates(parsed['dump-service-confirmed'], metroArea, c => applyToServiceDates(c, formatDateToISO))

  const { past: pastConfirmedInHistory, current: currentConfirmed } = splitConfirmedByDate(confirmedWithDates, asOf)
  const currentConfirmedForDisplay = currentConfirmed.map(c => applyToServiceDates(c, convertToDisplayFormat))

  const historyWithDates = getMetroSectionWithDates(
    parsed['dump-service-history'].filter(h => h['Service Name'] !== 'Member Added'),
    metroArea,
    h => applyToServiceDates(h, formatDateToISO)
  )

  const historyUnmatchedWithDates = parsed['dump-service-history-unmatched']
    ? getMetroSectionWithDates(
        parsed['dump-service-history-unmatched'].filter(h => h['Service Name'] !== 'Member Added'),
        metroArea,
        h => applyToServiceDates(h, formatDateToISO)
      )
    : []

  const historyForDisplay = mergeAndNormalizeHistory(historyWithDates, historyUnmatchedWithDates, pastConfirmedInHistory, historyHeadersInOriginalOrder).map(h => applyToServiceDates(h, convertToDisplayFormat))

  const providers = parsed['dump-service-provider'].filter(p => p['Metro Area'] === metroArea)
  const categories = parsed['dump-service-provider-category'].filter(c => c['Metro Area'] === metroArea)
  const flatProviders = flattenProviderCategories(providers, categories)
  const cleanProviders = removeMetroAreaColumn(flatProviders)

  return {
    Members: membersWithDates,
    Volunteers: cleanProviders,
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

const defaultCounts = () => ({ open: 0, confirmed: 0, completed: 0, unmatched: 0, cancelled: 0 })

function countByField(fieldName, openRecords = [], confirmedRecords = [], historyRecords = []) {
  const counts = {}

  for (const record of openRecords) {
    const name = record[fieldName] || ''
    if (name.trim()) {
      counts[name] ??= defaultCounts()
      counts[name].open += 1
    }
  }

  for (const record of confirmedRecords) {
    const name = record[fieldName] || ''
    if (name.trim()) {
      counts[name] ??= defaultCounts()
      counts[name].confirmed += 1
    }
  }

  for (const record of historyRecords) {
    const name = record[fieldName] || ''
    if (name.trim()) {
      counts[name] ??= defaultCounts()
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

class DumpChainData {
  #parsed

  constructor(parsed) {
    this.#parsed = parsed
  }

  static from(csvContent) {
    const parsed = parseDumpChain(csvContent)
    if (Object.keys(parsed).length === 0) {
      throw new Error('CSV produced no parseable sections')
    }
    return new DumpChainData(parsed)
  }

  get parsed() {
    return this.#parsed
  }

  hasMetroArea(metroArea) {
    return hasMetroAreaData(this.#parsed, metroArea)
  }

  getMetroAreaData(metroArea, asOf = new Date()) {
    return getMetroAreaData(this.#parsed, metroArea, asOf)
  }

  metroAreas() {
    const sections = ['dump-member', 'dump-service-requested', 'dump-service-confirmed', 'dump-service-history', 'dump-service-provider']
    const areas = new Set()
    for (const section of sections) {
      for (const record of (this.#parsed[section] || [])) {
        if (record['Metro Area']) areas.add(record['Metro Area'])
      }
    }
    return Array.from(areas).sort()
  }
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
  getMemberVolunteerCounts,
  DumpChainData
}
