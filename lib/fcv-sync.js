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
  'Outing ( events, movies, Sr Center,  etc.)': 'outing',
  'Dining out': 'dining',
  'Wellness check-in (follow up after illness or hospitalization)': 'wellness',
  'Pet visit': 'pet',
  'Other': 'other'
}

function normalizeVillageName(name) {
  return VILLAGE_NAME_MAP[name] ?? name
}

function mapActivityTypes(answers) {
  if (!answers || answers.length === 0) return []
  return answers.map(a => ACTIVITY_TYPE_MAP[a] ?? a)
}

function mapSubmissionToRow(submission) {
  const { answers } = submission
  const villageName = normalizeVillageName(answers[10]?.answer ?? '')
  const volunteerName = `${answers[2]?.answer?.last ?? ''}, ${answers[2]?.answer?.first ?? ''}`.trim()
  const memberName = `${answers[3]?.answer?.last ?? ''}, ${answers[3]?.answer?.first ?? ''}`.trim()
  const activityTypes = mapActivityTypes(answers[21]?.answer)

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
    submittedAt: submission.created_at
  }
}

async function fetchSubmissions(apiKey, formId, lastId) {
  const filter = lastId ? JSON.stringify({ 'id:gt': lastId }) : null
  const params = new URLSearchParams({ limit: '300', orderby: 'id' })
  if (filter) params.set('filter', filter)
  const url = `https://api.jotform.com/form/${formId}/submissions?${params}`
  const res = await fetch(url, { headers: { APIKEY: apiKey } })
  if (!res.ok) throw new Error(`JotForm API returned ${res.status}`)
  const json = await res.json()
  return json.content ?? []
}

async function syncFCV(dbConfig, jotformConfig) {
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
    const rowsJson = JSON.stringify(rows)

    await conn.query(
      `INSERT INTO fcv_submission
         (id, villageId, villageName, volunteerPersonId, rawVolunteerName,
          memberPersonId, rawMemberName, visitDate, timeSpentMinutes,
          contactType, activityTypes, notes, submittedAt)
       SELECT
         f.id,
         v.id,
         CASE WHEN v.id IS NULL THEN f.villageName END,
         pv.id,
         CASE WHEN pv.id IS NULL THEN f.volunteerName END,
         pm.id,
         CASE WHEN pm.id IS NULL THEN f.memberName END,
         f.visitDate,
         f.timeSpentMinutes,
         f.contactType,
         f.activityTypes,
         f.notes,
         f.submittedAt
       FROM JSON_TABLE(?, '$[*]' COLUMNS (
         id BIGINT UNSIGNED PATH '$.id',
         villageName VARCHAR(200) PATH '$.villageName',
         volunteerName VARCHAR(200) PATH '$.volunteerName',
         memberName VARCHAR(200) PATH '$.memberName',
         visitDate DATE PATH '$.visitDate',
         timeSpentMinutes INT PATH '$.timeSpentMinutes',
         contactType VARCHAR(50) PATH '$.contactType',
         activityTypes JSON PATH '$.activityTypes',
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

export { syncFCV, normalizeVillageName, mapActivityTypes }
