import dotenv from 'dotenv'
dotenv.config()

import imapSimple from 'imap-simple'
import { simpleParser } from 'mailparser'
import fs from 'fs'
import { google } from 'googleapis'
import { DumpChainData } from './lib/dump-chain-processor.js'
import { SheetsSyncer } from './lib/sheets-sync.js'
import { syncDB } from './lib/db-sync.js'
import { info, error, warn } from './lib/logger.js'
import { productionMetroAreas, devMetroAreas, hubSpreadsheetId, devHubSpreadsheetId } from './lib/metro-areas.js'

function validateConfig() {
  const useDevSheets = process.env.USE_DEV_SHEETS === 'true'
  const metroAreas = useDevSheets ? devMetroAreas : productionMetroAreas
  const activeHubSpreadsheetId = useDevSheets ? devHubSpreadsheetId : hubSpreadsheetId

  const testSpreadsheetId = process.env.TEST_SPREADSHEET_ID || null
  const metroAreasEnv = process.env.METRO_AREAS || null
  const debugHubOnly = process.env.DEBUG_HUB_ONLY === 'true'

  if (testSpreadsheetId && !metroAreasEnv) {
    throw new Error('TEST_SPREADSHEET_ID requires METRO_AREAS to be set')
  }

  let areas = Object.keys(metroAreas)
  let includeHub = true
  if (metroAreasEnv) {
    areas = metroAreasEnv.split(',').map(m => m.trim())
    includeHub = areas.includes('Hub')
  }

  const webhookUrl = process.env.VG_SYNC_WEBHOOK_URL || null
  const webhookKey = process.env.VG_SYNC_WEBHOOK_KEY || null

  const csvFile = process.env.CSV_FILE || null
  if (csvFile) {
    if (!fs.existsSync(csvFile)) throw new Error(`CSV file not found: ${csvFile}`)
    const dbConfig = createDbConfig()
    return { csvFile, metroAreas, hubSpreadsheetId: activeHubSpreadsheetId, areas, includeHub, testSpreadsheetId, debugHubOnly, dbConfig, webhookUrl, webhookKey }
  }

  const user = process.env.EMAIL_ADDRESS
  const password = process.env.EMAIL_PASSWORD
  if (!user || !password) throw new Error('Missing email credentials (EMAIL_ADDRESS, EMAIL_PASSWORD)')

  const imapConfig = {
    imap: {
      user,
      password,
      host: process.env.IMAP_HOST || 'imap.1and1.com',
      port: parseInt(process.env.IMAP_PORT || '993'),
      tls: process.env.IMAP_TLS !== 'false',
      tlsOptions: { rejectUnauthorized: false }
    }
  }

  const pollConfig = {
    fastIntervalMs: parseInt(process.env.POLL_FAST_INTERVAL_MS || '30000'),
    fastDurationMs: parseInt(process.env.POLL_FAST_DURATION_MS || '300000'),
    slowIntervalMs: parseInt(process.env.POLL_SLOW_INTERVAL_MS || '60000'),
    slowDurationMs: parseInt(process.env.POLL_SLOW_DURATION_MS || '3000000'),
  }

  const dbConfig = createDbConfig()
  return { imapConfig, pollConfig, metroAreas, hubSpreadsheetId: activeHubSpreadsheetId, areas, includeHub, testSpreadsheetId, debugHubOnly, dbConfig, webhookUrl, webhookKey }
}

function createDbConfig() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '60001'),
    user: process.env.DB_USER || 'vg',
    password: process.env.DB_PASSWORD || 'vgpw',
    database: process.env.DB_NAME || 'vg'
  }
}

async function notifyVgApi(webhookUrl, webhookKey) {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${webhookKey}`,
        'Content-Type': 'application/json'
      }
    })
    if (!res.ok) {
      warn(`VG webhook returned non-OK status`, { status: res.status, url: webhookUrl })
      return
    }
    info(`VG webhook notified`, { status: res.status, url: webhookUrl })
  } catch (err) {
    warn(`VG webhook request failed`, { url: webhookUrl, error: err.message })
  }
}

function createSheetsClient() {
  const clientSecretFile = process.env.OAUTH_CLIENT_SECRET_FILE || 'tokens/client_secret_1007583486586-05bi3ivgr0sr8ad2pe5gch29u2eigb26.apps.googleusercontent.com.json'
  const oauthTokenFile = process.env.OAUTH_TOKEN_FILE || 'tokens/oauth-token.json'

  const clientSecret = JSON.parse(fs.readFileSync(clientSecretFile, 'utf-8'))
  const oauthToken = JSON.parse(fs.readFileSync(oauthTokenFile, 'utf-8'))

  const auth = new google.auth.OAuth2({
    clientId: clientSecret.installed.client_id,
    clientSecret: clientSecret.installed.client_secret,
    redirectUrl: clientSecret.installed.redirect_uris[0]
  })
  auth.setCredentials({
    refresh_token: oauthToken.refresh_token
  })

  return google.sheets({ version: 'v4', auth })
}

async function syncSheetWithRetry({ sheetsClient, metroArea, spreadsheetId, metroData, emailTimestamp, maxRetries = 5, timeoutMs = 60000 }) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      info(`Syncing metro area`, { metroArea, attempt, maxRetries })

      const syncer = new SheetsSyncer(sheetsClient, spreadsheetId)
      const syncPromise = syncer.syncMetroArea(metroData, { emailTimestamp, metroArea })
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
      )

      await Promise.race([syncPromise, timeoutPromise])
      info(`Metro area sync complete`, { metroArea, tabCount: Object.keys(metroData.tabs).length })
      return
    } catch (err) {
      if (attempt === maxRetries) {
        error(`Metro area sync failed after max retries`, { metroArea, maxRetries, error: err.message })
        throw err
      }
      const delay = Math.pow(2, attempt - 1) * 1000
      warn(`Metro area sync failed, retrying`, { metroArea, attempt, nextRetryMs: delay, error: err.message })
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

async function syncSheets(sheetsClient, data, config, timestamp) {
  const { areas, includeHub, hubSpreadsheetId, testSpreadsheetId, metroAreas, debugHubOnly } = config
  const useTestSheet = !!testSpreadsheetId

  if (process.env.METRO_AREAS) {
    info(`Metro areas filtered by env var`, { count: areas.length, areas, includeHub })
  } else {
    info(`Metro areas using defaults (all metro areas + Hub)`)
  }

  if (useTestSheet) {
    info(`Using test spreadsheet`, { testId: testSpreadsheetId })
  }

  info(`Starting sheet sync`, { count: areas.length, emailSentTimestamp: timestamp, includeHub })

  if (includeHub) {
    info(`Syncing Hub spreadsheet`)
    try {
      const hubSheet = new SheetsSyncer(sheetsClient, hubSpreadsheetId)
      await hubSheet.syncHub(data.getHubData(metroAreas), timestamp)
    } catch (err) {
      error(`Hub sync failed`, { error: err.message })
    }
  }

  const metroOnlyAreas = areas.filter(a => a !== 'Hub')
  info(`Starting metro area syncs`, { count: metroOnlyAreas.length })

  if (debugHubOnly !== true) {
    for (const [i, metroArea] of metroOnlyAreas.entries()) {
      const spreadsheetId = useTestSheet ? testSpreadsheetId : metroAreas[metroArea]
      if (!spreadsheetId) {
        warn(`Metro area not found in config`, { metroArea })
        continue
      }
      if (!data.hasMetroArea(metroArea)) {
        warn(`Metro area absent from CSV, skipping sheet update`, { metroArea })
        continue
      }
      const metroData = data.getMetroAreaData(metroArea)
      await syncSheetWithRetry({ sheetsClient, metroArea, spreadsheetId, metroData, emailTimestamp: timestamp })
      if (i < metroOnlyAreas.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 10000))
      }
    }
  } else {
    info(`Skipping per-metro area syncs (DEBUG_HUB_ONLY=true)`)
  }

  info(`All sheet syncs complete`)
}

async function checkForMessage(imapConfig) {
  let connection
  try {
    connection = await imapSimple.connect(imapConfig)
    await connection.openBox('INBOX')

    const searchCriteria = [['FROM', 'scheduler@mail2.clubexpress.com'], ['UNSEEN']]
    const messages = await connection.search(searchCriteria, { bodies: '' })

    info(`IMAP search complete`, { messageCount: messages.length })

    if (messages.length === 0) {
      return null
    }

    const message = messages[0]
    const parsed = await simpleParser(message.parts[0].body)
    const subject = parsed.subject || ''
    const from = parsed.from?.text || ''

    info(`Message parsed`, { subject, from })

    if (subject !== 'Report') {
      warn(`Message skipped due to subject`, { subject, expected: 'Report' })
      return null
    }

    const timestamp = parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString()
    info(`Processing email message`, { subject, emailSentTimestamp: timestamp })

    if (!parsed.attachments?.length) {
      warn(`Email has no attachments`, { subject })
      return null
    }

    for (const attachment of parsed.attachments) {
      if (attachment.filename.endsWith('.csv')) {
        const csvContent = attachment.content.toString('utf-8')
        info(`Processing CSV attachment`, { filename: attachment.filename, sizeBytes: csvContent.length })
        await connection.addFlags(message.attributes.uid, ['\\Seen'])
        info(`Message marked as read`)
        return { csvContent, timestamp }
      }
    }

    warn(`Email has no CSV attachment`, { subject })
    return null
  } catch (err) {
    error(`IMAP check failed`, { error: err.message })
    return null
  } finally {
    if (connection) {
      try {
        await connection.end()
      } catch (e) {
        // ignore
      }
    }
  }
}

async function pollUntilMessage(imapConfig, pollConfig) {
  const { fastIntervalMs, fastDurationMs, slowIntervalMs, slowDurationMs } = pollConfig

  info(`Polling started`, { pollFastIntervalMs: fastIntervalMs, pollFastDurationMs: fastDurationMs, pollSlowIntervalMs: slowIntervalMs, pollSlowDurationMs: slowDurationMs })

  const startTime = Date.now()
  const maxWaitMs = fastDurationMs + slowDurationMs

  while (true) {
    const result = await checkForMessage(imapConfig)
    if (result) {
      info(`Message found and processed`)
      return result
    }

    const elapsedMs = Date.now() - startTime
    if (elapsedMs >= maxWaitMs) {
      warn(`Polling timeout reached`, { elapsedMs, maxWaitMs })
      return null
    }

    const inFastPhase = elapsedMs < fastDurationMs
    const interval = inFastPhase ? fastIntervalMs : slowIntervalMs
    const phase = inFastPhase ? 'fast' : 'slow'

    info(`No message found, sleeping`, { phase, intervalMs: interval, elapsedMs, maxWaitMs })
    await new Promise(resolve => setTimeout(resolve, interval))
  }
}

try {
  const config = validateConfig()
  let csvContent, timestamp

  if (config.csvFile) {
    info(`Processing CSV file`, { csvFilePath: config.csvFile })
    csvContent = fs.readFileSync(config.csvFile, 'utf-8')
    timestamp = new Date().toISOString()
  } else {
    const result = await pollUntilMessage(config.imapConfig, config.pollConfig)
    if (result) {
      ({ csvContent, timestamp } = result)
    }
  }

  if (csvContent) {
    const data = DumpChainData.from(csvContent)
    const sheetsClient = createSheetsClient()

    if (config.dbConfig) {
      info(`Starting database sync`)
      await syncDB(config.dbConfig, data, timestamp)
      info(`Database sync complete`)
      if (config.webhookUrl) {
        await notifyVgApi(config.webhookUrl, config.webhookKey)
      }
    }

    info(`Starting sheet sync`)
    await syncSheets(sheetsClient, data, config, timestamp)
    info(`Sheet sync complete`)

    info(`File processing complete`)
  }

  process.exit(0)
} catch (err) {
  error(`Unhandled error`, { error: err.message })
  process.exit(1)
}
