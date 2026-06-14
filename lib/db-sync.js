import mysql from 'mysql2/promise'
import {
  toPersonRow,
  toMemberRow,
  toVolunteerRow,
  toVolunteerCapabilityRows,
  toServiceRequestRow
} from './row-mappers.js'

function resolveStatus(row, timestamp) {
  if (row.status === 'Confirmed' && row.finish_at && timestamp) {
    const finishAt = new Date(row.finish_at.replace(' ', 'T') + 'Z')
    if (finishAt < timestamp) return 'Completed'
  }
  return row.status
}

async function createConnection(config) {
  return mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    multipleStatements: true
  })
}

async function bulkInsert(conn, table, rows) {
  if (rows.length === 0) return
  const columns = Object.keys(rows[0])
  const placeholders = `(${columns.map(() => '?').join(', ')})`
  const values = rows.map(row => columns.map(c => row[c]))
  const sql = `INSERT INTO \`${table}\` (${columns.map(c => `\`${c}\``).join(', ')}) VALUES ${rows.map(() => placeholders).join(', ')}`
  await conn.query(sql, values.flat())
}

async function syncAll(conn, data, timestamp) {
  const parsed = data.parsed

  // capability table is reference data — never truncated
  const [capabilityRows] = await conn.query('SELECT id, name FROM capability')
  const capabilityMap = Object.fromEntries(capabilityRows.map(r => [r.name, r.id]))

  // --- Truncate all tables (disable FK checks first) ---
  await conn.query('SET FOREIGN_KEY_CHECKS = 0')
  await conn.query('TRUNCATE TABLE service_request')
  await conn.query('TRUNCATE TABLE volunteer_capability')
  await conn.query('TRUNCATE TABLE volunteer')
  await conn.query('TRUNCATE TABLE member')
  await conn.query('TRUNCATE TABLE person')
  await conn.query('TRUNCATE TABLE village')
  await conn.query('TRUNCATE TABLE ce_dump')
  await conn.query('SET FOREIGN_KEY_CHECKS = 1')

  // --- Villages ---
  const metroAreas = data.metroAreas()
  for (const area of metroAreas) {
    await conn.query('INSERT INTO village (name) VALUES (?)', [area])
  }

  // Build de-duplicated person set keyed by full_name only
  const personRowMap = new Map()
  for (const raw of (parsed['dump-member'] || [])) {
    if (!personRowMap.has(raw['Name'])) {
      personRowMap.set(raw['Name'], toPersonRow(raw))
    }
  }
  for (const raw of (parsed['dump-service-provider'] || [])) {
    if (raw['Name'].startsWith('SRLog,')) continue
    if (!personRowMap.has(raw['Name'])) {
      personRowMap.set(raw['Name'], toPersonRow(raw))
    }
  }

  const personRows = Array.from(personRowMap.values())
  if (personRows.length > 0) {
    const pJson = JSON.stringify(personRows)
    await conn.query(
      `INSERT INTO person (village_id, full_name, last_name, first_name, nickname, address, city, state, zip, email, phone, cell, birth_date, emergency_contact_name, emergency_contact_relationship, emergency_contact_phone, emergency_contact_email)
       SELECT v.id, p.full_name, p.last_name, p.first_name, p.nickname, p.address, p.city, p.state, p.zip, p.email, p.phone, p.cell, p.birth_date, p.emergency_contact_name, p.emergency_contact_relationship, p.emergency_contact_phone, p.emergency_contact_email
       FROM JSON_TABLE(?, '$[*]' COLUMNS (
         village_name VARCHAR(200) COLLATE utf8mb4_0900_ai_ci PATH '$.village_name',
         full_name VARCHAR(200) COLLATE utf8mb4_0900_ai_ci PATH '$.full_name',
         last_name VARCHAR(100) PATH '$.last_name',
         first_name VARCHAR(100) PATH '$.first_name',
         nickname VARCHAR(100) PATH '$.nickname',
         address VARCHAR(300) PATH '$.address',
         city VARCHAR(100) PATH '$.city',
         state VARCHAR(50) PATH '$.state',
         zip VARCHAR(20) PATH '$.zip',
         email VARCHAR(200) PATH '$.email',
         phone VARCHAR(50) PATH '$.phone',
         cell VARCHAR(50) PATH '$.cell',
         birth_date DATE PATH '$.birth_date',
         emergency_contact_name VARCHAR(200) PATH '$.emergency_contact_name',
         emergency_contact_relationship VARCHAR(100) PATH '$.emergency_contact_relationship',
         emergency_contact_phone VARCHAR(50) PATH '$.emergency_contact_phone',
         emergency_contact_email VARCHAR(200) PATH '$.emergency_contact_email'
       )) p
       JOIN village v ON v.name COLLATE utf8mb4_0900_ai_ci = p.village_name`,
      [pJson]
    )
  }


  // --- Members using INSERT...SELECT ---
  const memberRows = (parsed['dump-member'] || []).map(raw => ({...toMemberRow(raw), village_name: raw['Metro Area']}))
  if (memberRows.length > 0) {
    const mJson = JSON.stringify(memberRows)
    await conn.query(
      `INSERT INTO member (person_id, member_number, member_level, service_notes, join_date)
       SELECT p.id, m.member_number, m.member_level, m.service_notes, m.join_date
       FROM person p
       JOIN village v ON p.village_id = v.id
       JOIN JSON_TABLE(?, '$[*]' COLUMNS (
         village_name VARCHAR(200) COLLATE utf8mb4_0900_ai_ci PATH '$.village_name',
         full_name VARCHAR(200) COLLATE utf8mb4_0900_ai_ci PATH '$.full_name',
         member_number VARCHAR(50) PATH '$.member_number',
         member_level VARCHAR(100) PATH '$.member_level',
         service_notes TEXT PATH '$.service_notes',
         join_date DATE PATH '$.join_date'
       )) m ON v.name COLLATE utf8mb4_0900_ai_ci = m.village_name AND p.full_name COLLATE utf8mb4_0900_ai_ci = m.full_name`,
      [mJson]
    )
  }

  // --- Volunteers (deduplicated by full_name) using INSERT...SELECT ---
  const volunteerRowMap = new Map()
  for (const raw of (parsed['dump-service-provider'] || [])) {
    if (raw['Name'].startsWith('SRLog,')) continue
    if (!volunteerRowMap.has(raw['Name'])) {
      volunteerRowMap.set(raw['Name'], toVolunteerRow(raw))
    }
  }
  const volunteerRows = Array.from(volunteerRowMap.values())
  if (volunteerRows.length > 0) {
    const vJson = JSON.stringify(volunteerRows)
    await conn.query(
      `INSERT INTO volunteer (person_id)
       SELECT p.id
       FROM person p
       JOIN village vil ON p.village_id = vil.id
       JOIN JSON_TABLE(?, '$[*]' COLUMNS (
         village_name VARCHAR(200) COLLATE utf8mb4_0900_ai_ci PATH '$.village_name',
         full_name VARCHAR(200) COLLATE utf8mb4_0900_ai_ci PATH '$.full_name'
       )) v ON vil.name COLLATE utf8mb4_0900_ai_ci = v.village_name AND p.full_name COLLATE utf8mb4_0900_ai_ci = v.full_name`,
      [vJson]
    )
  }

  // --- Volunteer capabilities using INSERT...SELECT ---
  const capabilityRows2 = []
  for (const raw of (parsed['dump-service-provider-category'] || [])) {
    if (raw['Name'].startsWith('SRLog,')) continue
    const capabilityId = capabilityMap[raw['Category']]
    if (capabilityId === undefined) continue
    capabilityRows2.push({ full_name: raw['Name'], capability_id: capabilityId, village_name: raw['Metro Area'] })
  }
  if (capabilityRows2.length > 0) {
    const vcJson = JSON.stringify(capabilityRows2)
    await conn.query(
      `INSERT INTO volunteer_capability (volunteer_id, capability_id)
       SELECT v.id, vc.capability_id
       FROM volunteer v
       JOIN person p ON v.person_id = p.id
       JOIN village vil ON p.village_id = vil.id
       JOIN JSON_TABLE(?, '$[*]' COLUMNS (
         village_name VARCHAR(200) COLLATE utf8mb4_0900_ai_ci PATH '$.village_name',
         full_name VARCHAR(200) COLLATE utf8mb4_0900_ai_ci PATH '$.full_name',
         capability_id INT PATH '$.capability_id'
       )) vc ON vil.name COLLATE utf8mb4_0900_ai_ci = vc.village_name AND p.full_name COLLATE utf8mb4_0900_ai_ci = vc.full_name`,
      [vcJson]
    )
  }

  // --- Service requests using INSERT...SELECT ---
  const requestRows = []

  for (const raw of (parsed['dump-service-requested'] || [])) {
    requestRows.push(toServiceRequestRow(raw, 'Open', null))
  }
  for (const raw of (parsed['dump-service-confirmed'] || [])) {
    const row = toServiceRequestRow(raw, raw['Status'] || 'Confirmed', raw['Volunteer'])
    row.status = resolveStatus(row, timestamp)
    requestRows.push(row)
  }
  for (const raw of (parsed['dump-service-history'] || [])) {
    requestRows.push(toServiceRequestRow(raw, raw['Status'] || 'Completed', raw['Volunteer']))
  }
  for (const raw of (parsed['dump-service-history-unmatched'] || [])) {
    requestRows.push(toServiceRequestRow(raw, raw['Status'] || 'Unmatched', raw['Volunteer']))
  }

  if (requestRows.length > 0) {
    const srJson = JSON.stringify(requestRows)
    await conn.query(
      `INSERT INTO service_request (request_number, village_id, member_person_id, volunteer_person_id, status, service_name, transportation_type, created_at, start_at, finish_at, instructions, description, destination, address, city, phone)
       SELECT
         sr.request_number,
         v.id,
         (SELECT id FROM person WHERE full_name COLLATE utf8mb4_0900_ai_ci = sr.member_full_name),
         (SELECT id FROM person WHERE full_name COLLATE utf8mb4_0900_ai_ci = sr.volunteer_full_name),
         sr.status,
         sr.service_name,
         sr.transportation_type,
         sr.created_at,
         sr.start_at,
         sr.finish_at,
         sr.instructions,
         sr.description,
         sr.destination,
         sr.address,
         sr.city,
         sr.phone
       FROM village v
       JOIN JSON_TABLE(?, '$[*]' COLUMNS (
         request_number VARCHAR(50) PATH '$.request_number',
         village_name VARCHAR(200) COLLATE utf8mb4_0900_ai_ci PATH '$.village_name',
         member_full_name VARCHAR(200) COLLATE utf8mb4_0900_ai_ci PATH '$.member_full_name',
         volunteer_full_name VARCHAR(200) COLLATE utf8mb4_0900_ai_ci PATH '$.volunteer_full_name',
         status VARCHAR(50) PATH '$.status',
         service_name VARCHAR(200) PATH '$.service_name',
         transportation_type VARCHAR(100) PATH '$.transportation_type',
         created_at DATETIME PATH '$.created_at',
         start_at DATETIME PATH '$.start_at',
         finish_at DATETIME PATH '$.finish_at',
         instructions TEXT PATH '$.instructions',
         description TEXT PATH '$.description',
         destination TEXT PATH '$.destination',
         address TEXT PATH '$.address',
         city VARCHAR(100) PATH '$.city',
         phone VARCHAR(50) PATH '$.phone'
       )) sr ON v.name COLLATE utf8mb4_0900_ai_ci = sr.village_name`,
      [srJson]
    )
  }

  // --- Store dump timestamp (once per sync, for all villages) ---
  if (timestamp) {
    const mysqlTimestamp = timestamp.toISOString().slice(0, 19).replace('T', ' ')
    try {
      await conn.query('INSERT INTO ce_dump (ceDumpTime) VALUES (?)', [mysqlTimestamp])
    } catch (err) {
      console.error('Failed to insert ce_dump timestamp:', { mysqlTimestamp, error: err.message })
      throw err
    }
  }
}

async function syncDB(dbConfig, data, timestamp) {
  const conn = await createConnection(dbConfig)
  try {
    await syncAll(conn, data, timestamp)
  } finally {
    await conn.end()
  }
}

export { syncDB, syncAll, resolveStatus }
