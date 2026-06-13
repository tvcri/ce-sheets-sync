function toVillageRow(metroAreaName) {
  return { name: metroAreaName }
}

function parseIsoDate(str) {
  if (!str || !str.trim()) return null
  const trimmed = str.trim()

  // Already ISO format: YYYY-MM-DD
  const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/)
  if (isoMatch) return isoMatch[1]

  // CE format: M/D/YYYY or MM/DD/YYYY
  const ceMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (ceMatch) {
    const month = ceMatch[1].padStart(2, '0')
    const day = ceMatch[2].padStart(2, '0')
    const year = ceMatch[3]
    return `${year}-${month}-${day}`
  }

  return null
}

function parseIsoDatetime(str) {
  if (!str || !str.trim()) return null
  const trimmed = str.trim()

  // CE format: M/D/YYYY H:MM AM/PM
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}) (AM|PM)$/)
  if (!match) return null

  const month = parseInt(match[1], 10)
  const day = parseInt(match[2], 10)
  const year = parseInt(match[3], 10)
  let hours = parseInt(match[4], 10)
  const minutes = match[5]
  const period = match[6]

  if (period === 'PM' && hours !== 12) hours += 12
  if (period === 'AM' && hours === 12) hours = 0

  // Create date in local/runtime timezone and convert to UTC
  const localDate = new Date(year, month - 1, day, hours, parseInt(minutes, 10), 0)
  return localDate.toISOString().slice(0, 19).replace('T', ' ')
}

function str(val) {
  // NOTE: Previously called .trim() here to clean whitespace. Removed 2026-05-30 to surface
  // data quality issues (e.g., trailing spaces in names). If trimming is needed in future,
  // restore .trim() here, but be aware it masks data quality problems that should be
  // investigated at the source (Club Express CSV export).
  if (val === undefined || val === null || val === '') return null
  return val || null
}

function toPersonRow(raw) {
  return {
    village_name: raw['Metro Area'],
    full_name: raw['Name'],
    last_name: raw['Last Name'] || null,
    first_name: raw['First Name'] || null,
    nickname: raw['Nickname'] || null,
    address: raw['Address'] || null,
    city: raw['City'] || null,
    state: raw['State'] || null,
    zip: raw['Zip'] || null,
    email: raw['Email'] || null,
    phone: raw['Phone'] || null,
    cell: (raw['Cell'] ?? raw['Cell Phone']) || null,
    birth_date: parseIsoDate(raw['Birthday']),
    emergency_contact_name: raw['Emergency Contact Name'] || null,
    emergency_contact_relationship: raw['Emergency Contact Relationship'] || null,
    emergency_contact_phone: (raw['Emergency Contact Phone'] ?? raw['Emergency Phone']) || null,
    emergency_contact_email: raw['Emergency Contact Email'] || null
  }
}

function toMemberRow(raw) {
  return {
    full_name: raw['Name'],
    member_number: raw['Member Number'] || null,
    member_level: raw['Member Level'] || null,
    service_notes: raw['Service Notes'] || null,
    join_date: parseIsoDate(raw['Join Date'])
  }
}

function toVolunteerRow(raw) {
  return {
    full_name: raw['Name'],
    village_name: raw['Metro Area']
  }
}

function toVolunteerCapabilityRows(rawCategories, capabilityMap) {
  const rows = []
  for (const raw of rawCategories) {
    if (raw['Name'].startsWith('SRLog,')) continue
    const capabilityId = capabilityMap[raw['Category']]
    if (capabilityId === undefined) continue
    rows.push({ full_name: raw['Name'], capability_id: capabilityId })
  }
  return rows
}

function toServiceRequestRow(raw, status, volunteerName) {
  return {
    request_number: raw['Request Number'] || null,
    village_name: raw['Metro Area'],
    member_full_name: raw['Member'] || null,
    volunteer_full_name: volunteerName || null,
    status,
    service_name: raw['Service Name'] || null,
    transportation_type: raw['Transportation Type'] || null,
    created_at: parseIsoDatetime(raw['Created Date/Time']),
    start_at: parseIsoDatetime(raw['Start Date/Time']),
    finish_at: parseIsoDatetime(raw['Finish Date/Time']),
    instructions: raw['Instructions'] || null,
    description: raw['Description'] || null,
    destination: raw['Destination'] || null,
    address: raw['Address'] || null,
    city: raw['City'] || null,
    phone: raw['Phone'] || null
  }
}

export {
  toVillageRow,
  toPersonRow,
  toMemberRow,
  toVolunteerRow,
  toVolunteerCapabilityRows,
  toServiceRequestRow,
  parseIsoDate,
  parseIsoDatetime
}
