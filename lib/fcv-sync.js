import { createConnection } from './db-util.js'
import { info, warn } from './logger.js'

const VILLAGE_NAME_MAP = {
  'Aquidneck Island': 'Aquidneck'
}

const ACTIVITY_TYPE_MAP = {
  'Companionship/Friendly Conversation (sharing stories, current events, photos)': 'companionship',
  'Shared Activity (board game, cards, puzzles, craft)': 'activity',
  'Assistance (reading aloud, writing a letter, helping with simple tasks)': 'assistance',
  'Outdoors (walking, gardening, birding, etc)': 'outdoors',
  'Outing (\xa0events, movies, Sr Center,\xa0 etc.)': 'outing',
  'Dining out': 'dining',
  'Wellness check-in (follow up after illness or hospitalization)': 'wellness',
  'Pet visit': 'pet',
  'Other': 'other'
}

function normalizeVillageName(name) {
  return VILLAGE_NAME_MAP[name] ?? name
}

function mapActivityTypes(answers) {
  if (!answers) return []
  if (Array.isArray(answers)) return answers.map(a => ACTIVITY_TYPE_MAP[a] ?? a)
  // Dict form: numeric keys hold standard activity strings, "other" key indicates Other was selected
  const values = Object.entries(answers)
    .filter(([k]) => k !== 'other')
    .map(([, v]) => ACTIVITY_TYPE_MAP[v] ?? v)
  if ('other' in answers) values.push('other')
  return values
}

function extractActivityOther(answers) {
  if (!answers || Array.isArray(answers)) return null
  const text = answers.other ?? null
  return text || null
}

async function fuzzyMatchNames(unmatchedNames, personNames, anthropicApiKey) {
  const prompt = `You are matching names from a form submission against a membership database.
The database contains these person names (in "Last, First" format):
${personNames.join('\n')}

For each of the following submitted names, find the best match from the database list above.
Return ONLY a JSON object mapping each submitted name to its best database match, or null if no reasonable match exists.
A reasonable match handles: typos, extra/missing characters, nicknames (e.g. Deb→Debra, Pat→Patricia, Betsy→Elizabeth, Liz→Elizabeth, Sue→Susan, Tom→Thomas, Kay-Kathleen), truncations, accidental spaces, date strings accidentally appended to names, and initials or abbreviated first names (e.g. "D J" or "D." matching "David", "J" matching "John").
Do not match names where only the last name matches and the first name is completely unrelated (not an abbreviation, initial, or nickname of the database name).
Names to match: ${JSON.stringify(unmatchedNames)}
Respond with only the JSON object, no explanation.`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
  })
  if (!res.ok) throw new Error(`Anthropic API returned ${res.status}`)
  const json = await res.json()
  const raw = json.content?.[0]?.text ?? '{}'
  const text = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  return JSON.parse(text)
}

function mapSubmissionToRow(submission) {
  const { answers } = submission
  const villageName = normalizeVillageName(answers[10]?.answer ?? '')
  const volunteerName = `${answers[2]?.answer?.last ?? ''}, ${answers[2]?.answer?.first ?? ''}`.trim()
  const memberName = `${answers[3]?.answer?.last ?? ''}, ${answers[3]?.answer?.first ?? ''}`.trim()
  const activityTypes = mapActivityTypes(answers[21]?.answer)
  const activityOther = extractActivityOther(answers[21]?.answer)

  return {
    id: submission.id,
    villageName,
    volunteerName,
    memberName,
    visitDate: answers[4]?.answer?.datetime?.slice(0, 10) ?? null,
    timeSpentMinutes: parseInt(answers[5]?.answer ?? '0', 10),
    contactType: answers[6]?.answer ?? null,
    notes: answers[8]?.answer ?? null,
    activityTypes: activityTypes,
    activityOther,
    submittedAt: submission.created_at
  }
}

async function fetchSubmissions(apiKey, formId, lastId) {
  const filter = lastId ? JSON.stringify({ 'id:gt': String(lastId) }) : null
  const params = new URLSearchParams({ limit: '300', orderby: 'id' })
  if (filter) params.set('filter', filter)
  const url = `https://api.jotform.com/form/${formId}/submissions?${params}`
  const res = await fetch(url, { headers: { APIKEY: apiKey } })
  if (!res.ok) throw new Error(`JotForm API returned ${res.status}`)
  const json = await res.json()
  return json.content ?? []
}

async function syncFCV(dbConfig, jotformConfig, anthropicApiKey) {
  const { apiKey, formId } = jotformConfig
  const conn = await createConnection(dbConfig)
  try {
    const [[{ lastId }]] = await conn.query('SELECT MAX(id) as lastId FROM fcv_submission')
    info('FCV sync: queried cursor', { lastId })

    let submissions
    try {
      submissions = await fetchSubmissions(apiKey, formId, lastId)
    } catch (err) {
      warn('FCV sync: JotForm API fetch failed', { error: err.message })
      return
    }

    if (!submissions.length) {
      info('FCV sync: no new submissions')
      return
    }

    info('FCV sync: fetched submissions', { count: submissions.length })

    const rows = submissions.map(mapSubmissionToRow)

    // Fuzzy match any names that won't resolve via exact JOIN
    if (anthropicApiKey) {
      const [personRows] = await conn.query('SELECT TRIM(full_name) AS name FROM person')
      const personNames = personRows.map(r => r.name)
      const personNameSet = new Set(personNames)

      const unmatchedNames = [...new Set(
        rows.flatMap(r => [r.volunteerName, r.memberName].filter(n => n && !personNameSet.has(n)))
      )]

      if (unmatchedNames.length) {
        info('FCV sync: fuzzy matching unmatched names', { count: unmatchedNames.length })
        let corrections = {}
        try {
          corrections = await fuzzyMatchNames(unmatchedNames, personNames, anthropicApiKey)
        } catch (err) {
          warn('FCV sync: fuzzy match API call failed', { error: err.message })
        }

        for (const row of rows) {
          if (row.volunteerName && corrections[row.volunteerName]) {
            const original = row.volunteerName
            warn('FCV sync: fuzzy matched volunteer name', { original, matched: corrections[original] })
            row.rawVolunteerName = original
            row.fuzzyVolunteerName = corrections[original]
            row.volunteerName = corrections[original]
          }
          if (row.memberName && corrections[row.memberName]) {
            const original = row.memberName
            warn('FCV sync: fuzzy matched member name', { original, matched: corrections[original] })
            row.rawMemberName = original
            row.fuzzyMemberName = corrections[original]
            row.memberName = corrections[original]
          }
        }
      }
    }

    const rowsJson = JSON.stringify(rows)

    await conn.query(
      `INSERT IGNORE INTO fcv_submission
         (id, villageId, villageName, volunteerPersonId, rawVolunteerName, fuzzyVolunteerName,
          memberPersonId, rawMemberName, fuzzyMemberName, visitDate, timeSpentMinutes,
          contactType, activityTypes, activityOther, notes, submittedAt)
       SELECT
         f.id,
         v.id,
         CASE WHEN v.id IS NULL THEN f.villageName END,
         pv.id,
         COALESCE(f.rawVolunteerName, CASE WHEN pv.id IS NULL THEN f.volunteerName END),
         f.fuzzyVolunteerName,
         pm.id,
         COALESCE(f.rawMemberName, CASE WHEN pm.id IS NULL THEN f.memberName END),
         f.fuzzyMemberName,
         f.visitDate,
         f.timeSpentMinutes,
         f.contactType,
         f.activityTypes,
         f.activityOther,
         f.notes,
         f.submittedAt
       FROM JSON_TABLE(?, '$[*]' COLUMNS (
         id BIGINT UNSIGNED PATH '$.id',
         villageName VARCHAR(200) PATH '$.villageName',
         volunteerName VARCHAR(200) PATH '$.volunteerName',
         rawVolunteerName VARCHAR(200) PATH '$.rawVolunteerName',
         fuzzyVolunteerName VARCHAR(200) PATH '$.fuzzyVolunteerName',
         memberName VARCHAR(200) PATH '$.memberName',
         rawMemberName VARCHAR(200) PATH '$.rawMemberName',
         fuzzyMemberName VARCHAR(200) PATH '$.fuzzyMemberName',
         visitDate DATE PATH '$.visitDate',
         timeSpentMinutes INT PATH '$.timeSpentMinutes',
         contactType VARCHAR(50) PATH '$.contactType',
         activityTypes JSON PATH '$.activityTypes',
         activityOther VARCHAR(500) PATH '$.activityOther',
         notes TEXT PATH '$.notes',
         submittedAt DATETIME PATH '$.submittedAt'
       )) f
       LEFT JOIN village v ON v.name = f.villageName
       LEFT JOIN person pv ON TRIM(pv.full_name) = f.volunteerName
       LEFT JOIN person pm ON TRIM(pm.full_name) = f.memberName`,
      [rowsJson]
    )

    info('FCV sync: inserted submissions', { count: rows.length })
  } finally {
    await conn.end()
  }
}

export { syncFCV, normalizeVillageName, mapActivityTypes, fuzzyMatchNames }
