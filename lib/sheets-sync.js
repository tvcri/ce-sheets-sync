import { google } from 'googleapis'
import { info, error, warn } from './logger.js'
import { getProviderServiceCounts, getMemberRequestCounts, getProviderCategoryCounts, getServiceNameCounts, getMemberVolunteerCounts } from './dump-chain-processor.js'

async function syncTab(sheets, spreadsheetId, tabName, records, providerNames = new Set()) {
  if (records.length === 0) {
    info(`Clearing empty tab`, { tabName })
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${tabName}!A:Z`
    })
    return
  }

  info(`Syncing tab`, { tabName, recordCount: records.length })

  const headers = Object.keys(records[0])
  const isMemberIdx = headers.indexOf('IsMember')
  const isVolunteerIdx = headers.indexOf('Is volunteer')
  const yesNoColumns = ['Has smartphone', 'Has computer', 'Is volunteer']
  const yesNoIndices = yesNoColumns.map(col => headers.indexOf(col)).filter(idx => idx >= 0)

  const zipIdx = headers.indexOf('Zip')

  const rows = [headers, ...records.map(r => headers.map((h, colIdx) => {
    const value = r[h] || ''
    // Override Is volunteer based on provider lookup for Members tab
    if (tabName === 'Members' && colIdx === isVolunteerIdx) {
      const inProviders = providerNames.has(r['Name'].trim())
      const originalValue = value.toLowerCase()
      const isOriginalYes = originalValue === 'yes'
      // Use ✓ for original data, ◆ for overridden from provider lookup
      if (inProviders && !isOriginalYes) {
        return '◆'
      }
      return inProviders ? '✓' : ''
    }
    // Convert IsMember True/False to checkmark/blank
    if (colIdx === isMemberIdx) {
      return value === 'True' ? '✓' : ''
    }
    // Convert Yes/No columns to checkmark/blank
    if (yesNoIndices.includes(colIdx)) {
      return value === 'Yes' ? '✓' : ''
    }
    // Pad zip codes with leading zeros to 5 digits
    if (colIdx === zipIdx && value) {
      return value.padStart(5, '0')
    }
    return value
  }))]

  info(`Clearing tab data`, { tabName })
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${tabName}!A:Z`
  })

  info(`Writing tab data`, { tabName, rowCount: rows.length, colCount: headers.length })
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: rows
    }
  })
  info(`Tab sync complete`, { tabName })
}

function formatTimestampEastern(isoTimestamp) {
  const date = new Date(isoTimestamp)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  })
  const parts = formatter.formatToParts(date)
  const partMap = {}
  parts.forEach(part => {
    partMap[part.type] = part.value
  })
  return `${partMap.year}-${partMap.month}-${partMap.day} ${partMap.hour}:${partMap.minute}:${partMap.second} ${partMap.dayPeriod}`
}

function buildCellUpdateRequest(metadataSheetId, startColumnIndex, headers, rows) {
  const allRows = [headers, ...rows]
  return {
    updateCells: {
      range: {
        sheetId: metadataSheetId,
        startRowIndex: 40,
        startColumnIndex,
        endRowIndex: 40 + allRows.length,
        endColumnIndex: startColumnIndex + headers.length
      },
      rows: allRows.map((row, rowIdx) => ({
        values: row.map((val, colIdx) => {
          if (rowIdx === 0 || colIdx === 0) {
            return { userEnteredValue: { stringValue: val } }
          } else {
            return { userEnteredValue: { numberValue: val } }
          }
        })
      })),
      fields: 'userEnteredValue'
    }
  }
}

async function updateMetadata(sheets, spreadsheetId, metadata) {
  const {
    providerCounts = [],
    memberCounts = [],
    categoryCounts = [],
    serviceCounts = [],
    emailTimestampFormatted = '',
    endTimeFormatted = ''
  } = metadata

  try {
    info(`Updating metadata tab`)
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId })

    const metadataSheet = spreadsheet.data.sheets.find(s => s.properties.title === 'Metadata' || s.properties.title === '🕐')
    const dashboardSheet = spreadsheet.data.sheets.find(s => s.properties.title === 'Dashboard')

    if (!metadataSheet) {
      warn(`Metadata tab not found, skipping dashboard setup`)
      return
    }

    const metadataSheetId = metadataSheet.properties.sheetId
    const requests = []

    // Clear metadata data (rows 40 onwards, all data columns)
    requests.push({
      updateCells: {
        range: {
          sheetId: metadataSheetId,
          startRowIndex: 40,
          startColumnIndex: 0,
          endRowIndex: 1000,
          endColumnIndex: 19
        },
        rows: [],
        fields: 'userEnteredValue'
      }
    })

    // Add timestamp data to Metadata tab (row 1-2, columns A-B)
    requests.push({
      updateCells: {
        range: {
          sheetId: metadataSheetId,
          startRowIndex: 0,
          startColumnIndex: 0,
          endRowIndex: 2,
          endColumnIndex: 2
        },
        rows: [
          {
            values: [
              { userEnteredValue: { stringValue: 'Club Express Dump' } },
              { userEnteredValue: { stringValue: 'Written to Sheet' } }
            ]
          },
          {
            values: [
              { userEnteredValue: { stringValue: emailTimestampFormatted } },
              { userEnteredValue: { stringValue: endTimeFormatted } }
            ]
          }
        ],
        fields: 'userEnteredValue'
      }
    })

    // Add timestamp to Dashboard sheet (J3:L3 merged cell)
    if (dashboardSheet) {
      const dashboardSheetId = dashboardSheet.properties.sheetId
      requests.push({
        updateCells: {
          range: {
            sheetId: dashboardSheetId,
            startRowIndex: 2,
            startColumnIndex: 9,
            endRowIndex: 3,
            endColumnIndex: 12
          },
          rows: [
            {
              values: [
                { userEnteredValue: { stringValue: `Updated: ${emailTimestampFormatted}` } }
              ]
            }
          ],
          fields: 'userEnteredValue'
        }
      })
    }

    // Add Members/Volunteers data to Metadata tab (row 40, columns A-B)
    const memberVolunteerCounts = getMemberVolunteerCounts(metadata.members, metadata.providers)
    const memberVolunteerHeaders = ['Category', 'Count']
    const memberVolunteerRows = [
      [`Members (${memberVolunteerCounts.membersOnly})`, memberVolunteerCounts.membersOnly],
      [`Volunteers (${memberVolunteerCounts.volunteersOnly})`, memberVolunteerCounts.volunteersOnly],
      [`Both (${memberVolunteerCounts.both})`, memberVolunteerCounts.both]
    ]
    requests.push(buildCellUpdateRequest(metadataSheetId, 0, memberVolunteerHeaders, memberVolunteerRows))

    // Add provider service counts to Metadata tab (row 40, columns D-F)
    if (providerCounts.length > 0) {
      const headers = ['Provider', 'Confirmed', 'Completed']
      const rows = providerCounts.map(pc => [pc.name, pc.confirmed, pc.completed])
      requests.push(buildCellUpdateRequest(metadataSheetId, 3, headers, rows))
    }

    // Add member request counts to Metadata tab (row 40, columns H-N)
    if (memberCounts.length > 0) {
      const headers = ['Member', 'Unmatched', 'Cancelled', 'Open', 'Confirmed', 'Completed']
      const rows = memberCounts.map(mc => [mc.name, mc.unmatched, mc.cancelled, mc.open, mc.confirmed, mc.completed])
      requests.push(buildCellUpdateRequest(metadataSheetId, 7, headers, rows))
    }

    // Add provider category counts to Metadata tab (row 40, columns N-O)
    if (categoryCounts.length > 0) {
      const headers = ['Category', 'Count']
      const rows = categoryCounts.map(cc => [`${cc.name} (${cc.count})`, cc.count])
      requests.push(buildCellUpdateRequest(metadataSheetId, 13, headers, rows))
    }

    // Add service name counts to Metadata tab (row 40, columns P-U)
    if (serviceCounts.length > 0) {
      const headers = ['Service Name', 'Unmatched', 'Cancelled', 'Open', 'Confirmed', 'Completed']
      const rows = serviceCounts.map(sc => [`${sc.name} (${sc.open + sc.confirmed + sc.completed + sc.cancelled + sc.unmatched})`, sc.unmatched, sc.cancelled, sc.open, sc.confirmed, sc.completed])
      requests.push(buildCellUpdateRequest(metadataSheetId, 15, headers, rows))
    }

    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests }
      })
      info(`Metadata tab update complete`)
    }
  } catch (err) {
    warn(`Failed to setup dashboard`, { error: err.message })
  }
}

async function syncMetroArea(sheets, spreadsheetId, tabs, emailTimestamp, metroArea, parsed) {
  info(`Starting metro area sync`, { tabCount: Object.keys(tabs).length })

  // Get provider names for this metro area to override Is volunteer in Members tab
  const providers = parsed ? (parsed['dump-service-provider'] || []).filter(p => p['Metro Area'] === metroArea) : []
  const providerNames = new Set(providers.map(p => p['Name'].trim()))

  for (const [tabName, records] of Object.entries(tabs)) {
    if (!tabName.startsWith('_')) {
      await syncTab(sheets, spreadsheetId, tabName, records, providerNames)
    }
  }

  // Calculate provider service counts from history and confirmed
  const providerCounts = getProviderServiceCounts(
    tabs['Requests History'] || [],
    tabs['Requests Confirmed'] || []
  )

  // Calculate member request counts
  const memberCounts = getMemberRequestCounts(
    tabs['Requests Open'] || [],
    tabs['Requests Confirmed'] || [],
    tabs['Requests History'] || []
  )

  // Calculate provider category counts from raw parsed data
  const categoryRecords = parsed ? (parsed['dump-service-provider-category'] || []).filter(c => c['Metro Area'] === metroArea) : []
  const categoryCounts = getProviderCategoryCounts(categoryRecords)

  // Calculate service name counts
  const serviceCounts = getServiceNameCounts(
    tabs['Requests Open'] || [],
    tabs['Requests Confirmed'] || [],
    tabs['Requests History'] || []
  )

  // Get members for this metro area from raw parsed data
  const members = parsed ? (parsed['dump-member'] || []).filter(m => m['Metro Area'] === metroArea) : []

  const endTime = new Date().toISOString()
  const emailTimestampFormatted = formatTimestampEastern(emailTimestamp)
  const endTimeFormatted = formatTimestampEastern(endTime)

  info(`Updating metadata tab`, { clubExpressDump: emailTimestampFormatted, writtenToSheet: endTimeFormatted })

  // Update metadata after syncing all tabs
  await updateMetadata(sheets, spreadsheetId, {
    providerCounts,
    memberCounts,
    categoryCounts,
    serviceCounts,
    members,
    providers,
    emailTimestampFormatted,
    endTimeFormatted
  })
}

export {
  syncTab,
  syncMetroArea
}
