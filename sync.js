import dotenv from 'dotenv'
dotenv.config()

import imapSimple from 'imap-simple'
import { simpleParser } from 'mailparser'
import fs from 'fs'
import { google } from 'googleapis'
import { parseDumpChain, getMetroAreaData } from './lib/dump-chain-processor.js'
import { syncMetroArea, syncHub } from './lib/sheets-sync.js'
import { info, error, warn } from './lib/logger.js'
import { productionMetroAreas, devMetroAreas, hubSpreadsheetId, devHubSpreadsheetId } from './lib/metro-areas.js'

const metroAreas = process.env.USE_DEV_SHEETS === 'true' ? devMetroAreas : productionMetroAreas
const activeHubSpreadsheetId = process.env.USE_DEV_SHEETS === 'true' ? devHubSpreadsheetId : hubSpreadsheetId

// Ionos/1&1 IMAP — host/port/TLS defaults match their standard config
const imapConfig = {
  imap: {
    user: process.env.EMAIL_ADDRESS,
    password: process.env.EMAIL_PASSWORD,
    host: process.env.IMAP_HOST || 'imap.1and1.com',
    port: parseInt(process.env.IMAP_PORT || '993'),
    tls: process.env.IMAP_TLS !== 'false',
    tlsOptions: { rejectUnauthorized: false }
  }
}

const csvFilePath = process.env.CSV_FILE
if (csvFilePath) {
  if (!fs.existsSync(csvFilePath)) {
    error('CSV file not found', { csvFilePath })
    process.exit(1)
  }
} else if (!imapConfig.imap.user || !imapConfig.imap.password) {
  error('Missing email credentials', {
    EMAIL_ADDRESS: !!process.env.EMAIL_ADDRESS,
    EMAIL_PASSWORD: !!process.env.EMAIL_PASSWORD
  })
  console.error('Usage: EMAIL_ADDRESS=user@example.com EMAIL_PASSWORD=pass node sync.js')
  process.exit(1)
}

async function syncSheetWithRetry(sheets, metroArea, spreadsheetId, tabs, emailTimestamp, parsed, maxRetries = 5, timeoutMs = 60000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      info(`Syncing metro area`, { metroArea, attempt, maxRetries })

      const syncPromise = syncMetroArea(sheets, spreadsheetId, tabs, emailTimestamp, metroArea, parsed)
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
      )

      await Promise.race([syncPromise, timeoutPromise])
      info(`Metro area sync complete`, { metroArea, tabCount: Object.keys(tabs).length })
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

async function syncSheets(csvContent, emailSentTimestamp) {
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

  const sheets = google.sheets({ version: 'v4', auth })
  const parsed = parseDumpChain(csvContent)

  const useTestSheet = !!process.env.TEST_SPREADSHEET_ID
  if (useTestSheet && !process.env.METRO_AREAS) {
    error(`TEST_SPREADSHEET_ID requires METRO_AREAS to be set`)
    process.exit(1)
  }

  let areas = Object.keys(metroAreas)
  let includeHub = true
  if (process.env.METRO_AREAS) {
    areas = process.env.METRO_AREAS.split(',').map(m => m.trim())
    includeHub = areas.includes('Hub')
    info(`Metro areas filtered by env var`, { count: areas.length, areas, includeHub })
  } else {
    info(`Metro areas using defaults (all metro areas + Hub)`)
  }

  if (useTestSheet) {
    info(`Using test spreadsheet`, { testId: process.env.TEST_SPREADSHEET_ID })
  }

  info(`Starting sheet sync`, { count: areas.length, emailSentTimestamp, includeHub })

  // Sync Hub first for fastest aggregated view
  if (includeHub) {
    info(`Syncing Hub spreadsheet`)
    try {
      await syncHub(sheets, activeHubSpreadsheetId, parsed, emailSentTimestamp)
    } catch (err) {
      error(`Hub sync failed`, { error: err.message })
    }
  }

  const metroOnlyAreas = areas.filter(a => a !== 'Hub')
  info(`Starting metro area syncs`, { count: metroOnlyAreas.length })

  // Skip per-metro writes if DEBUG_HUB_ONLY=true (useful for testing hub sync in isolation)
  if (process.env.DEBUG_HUB_ONLY !== 'true') {
    for (const [i, metroArea] of metroOnlyAreas.entries()) {
      const spreadsheetId = useTestSheet ? process.env.TEST_SPREADSHEET_ID : metroAreas[metroArea]
      if (!spreadsheetId) {
        warn(`Metro area not found in config`, { metroArea })
        continue
      }
      const tabs = getMetroAreaData(parsed, metroArea)
      await syncSheetWithRetry(sheets, metroArea, spreadsheetId, tabs, emailSentTimestamp, parsed)
      if (i < metroOnlyAreas.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 10000))
      }
    }
  } else {
    info(`Skipping per-metro area syncs (DEBUG_HUB_ONLY=true)`)
  }

  info(`All sheet syncs complete`)
}

async function processMessage(emailMessage, subject) {
  const emailSentTimestamp = emailMessage.date ? new Date(emailMessage.date).toISOString() : new Date().toISOString()

  info(`Processing email message`, { subject, emailSentTimestamp })

  if (emailMessage.attachments && emailMessage.attachments.length > 0) {
    info(`Email has attachments`, { count: emailMessage.attachments.length })

    for (const attachment of emailMessage.attachments) {
      info(`Found attachment`, { filename: attachment.filename })

      if (attachment.filename.endsWith('.csv')) {
        const csvContent = attachment.content.toString('utf-8')
        info(`Processing CSV attachment`, { filename: attachment.filename, sizeBytes: csvContent.length })

        try {
          await syncSheets(csvContent, emailSentTimestamp)
          info(`Email processing complete`, { filename: attachment.filename })
        } catch (err) {
          error(`Email processing failed`, { filename: attachment.filename, error: err.message })
        }
      }
    }
  } else {
    warn(`Email has no attachments`, { subject })
  }
}

async function checkForMessage() {
  let connection
  try {
    connection = await imapSimple.connect(imapConfig)
    await connection.openBox('INBOX')

    const searchCriteria = [['FROM', 'scheduler@mail2.clubexpress.com'], ['UNSEEN']]
    const messages = await connection.search(searchCriteria, { bodies: '' })

    info(`IMAP search complete`, { messageCount: messages.length })

    if (messages.length === 0) {
      return false
    }

    const message = messages[0]
    try {
      const parsed = await simpleParser(message.parts[0].body)
      const subject = parsed.subject || ''
      const from = parsed.from?.text || ''

      info(`Message parsed`, { subject, from })

      if (subject === 'Report') {
        await processMessage(parsed, subject)
        await connection.addFlags(message.attributes.uid, ['\\Seen'])
        info(`Message marked as read`)
        return true
      } else {
        warn(`Message skipped due to subject`, { subject, expected: 'Report' })
      }
    } catch (err) {
      error(`Failed to parse message`, { error: err.message })
    }

    return false
  } catch (err) {
    error(`IMAP check failed`, { error: err.message })
    return false
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

async function pollUntilMessage() {
  const pollFastIntervalMs = parseInt(process.env.POLL_FAST_INTERVAL_MS || '30000')
  const pollFastDurationMs = parseInt(process.env.POLL_FAST_DURATION_MS || '300000')
  const pollSlowIntervalMs = parseInt(process.env.POLL_SLOW_INTERVAL_MS || '60000')
  const pollSlowDurationMs = parseInt(process.env.POLL_SLOW_DURATION_MS || '3000000')

  info(`Polling started`, { pollFastIntervalMs, pollFastDurationMs, pollSlowIntervalMs, pollSlowDurationMs })

  const startTime = Date.now()
  const maxWaitMs = pollFastDurationMs + pollSlowDurationMs

  while (true) {
    const found = await checkForMessage()
    if (found) {
      info(`Message found and processed`)
      return
    }

    const elapsedMs = Date.now() - startTime
    if (elapsedMs >= maxWaitMs) {
      warn(`Polling timeout reached`, { elapsedMs, maxWaitMs })
      return
    }

    const inFastPhase = elapsedMs < pollFastDurationMs
    const interval = inFastPhase ? pollFastIntervalMs : pollSlowIntervalMs
    const phase = inFastPhase ? 'fast' : 'slow'

    info(`No message found, sleeping`, { phase, intervalMs: interval, elapsedMs, maxWaitMs })
    await new Promise(resolve => setTimeout(resolve, interval))
  }
}

async function main() {
  try {
    if (csvFilePath) {
      info(`Processing CSV file`, { csvFilePath })
      const csvContent = fs.readFileSync(csvFilePath, 'utf-8')
      const processingTimestamp = new Date().toISOString()
      await syncSheets(csvContent, processingTimestamp)
      info(`File processing complete`)
    } else {
      await pollUntilMessage()
    }
  } catch (err) {
    error(`Unhandled error in main`, { error: err.message })
    process.exit(1)
  }
}

main().then(() => {
  process.exit(0)
}).catch(err => {
  error(`Unhandled error`, { error: err.message })
  process.exit(1)
})
