import { google } from 'googleapis'
import { info, error, warn } from './logger.js'
import { getProviderServiceCounts, getMemberRequestCounts, getProviderCategoryCounts, getServiceNameCounts, getMemberVolunteerCounts } from './dump-chain-processor.js'
import { productionMetroAreas } from './metro-areas.js'

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

function buildTimestampRequests(metadataSheetId, dashboardSheetId, emailTimestampFormatted, endTimeFormatted) {
  const requests = []
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
  if (dashboardSheetId != null) {
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
  return requests
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

    const dashboardSheetId = dashboardSheet ? dashboardSheet.properties.sheetId : null
    requests.push(...buildTimestampRequests(metadataSheetId, dashboardSheetId, emailTimestampFormatted, endTimeFormatted))

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
      const rows = memberCounts.map(mc => [`${mc.name} (${mc.open + mc.confirmed + mc.completed})`, -mc.unmatched, -mc.cancelled, mc.open, mc.confirmed, mc.completed])
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
      const rows = serviceCounts.map(sc => [`${sc.name} (${sc.open + sc.confirmed + sc.completed})`, -sc.unmatched, -sc.cancelled, sc.open, sc.confirmed, sc.completed])
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

async function updateHubMetadata(sheets, spreadsheetId, hubData) {
  const {
    memberVolunteerCounts = {},
    categoryCounts = [],
    providerTotals = [],
    memberTotals = [],
    serviceCounts = [],
    emailTimestampFormatted = '',
    endTimeFormatted = ''
  } = hubData

  try {
    info(`Updating Hub metadata tab`, {
      memberVolunteerCountsKeys: Object.keys(memberVolunteerCounts),
      memberTotalsCount: memberTotals.length,
      serviceCounts: serviceCounts.length,
      categoryCounts: categoryCounts.length
    })
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId })

    const metadataSheet = spreadsheet.data.sheets.find(s => s.properties.title === 'Metadata' || s.properties.title === '🕐')
    const dashboardSheet = spreadsheet.data.sheets.find(s => s.properties.title === 'Dashboard')

    if (!metadataSheet) {
      warn(`Metadata tab not found, skipping Hub metadata update`)
      return
    }

    const metadataSheetId = metadataSheet.properties.sheetId
    const requests = []
    info(`Hub metadata sheet found`, { sheetId: metadataSheetId, sheetTitle: metadataSheet.properties.title })

    // Clear metadata data (rows 40 onwards, all data columns)
    requests.push({
      updateCells: {
        range: {
          sheetId: metadataSheetId,
          startRowIndex: 40,
          startColumnIndex: 0,
          endRowIndex: 1000,
          endColumnIndex: 25
        },
        rows: [],
        fields: 'userEnteredValue'
      }
    })

    const dashboardSheetId = dashboardSheet ? dashboardSheet.properties.sheetId : null
    requests.push(...buildTimestampRequests(metadataSheetId, dashboardSheetId, emailTimestampFormatted, endTimeFormatted))

    // Member/Volunteer/Both counts (col A-B)
    const memberVolunteerHeaders = ['Category', 'Count']
    const memberVolunteerRows = [
      [`Members (${memberVolunteerCounts.membersOnly || 0})`, memberVolunteerCounts.membersOnly || 0],
      [`Volunteers (${memberVolunteerCounts.volunteersOnly || 0})`, memberVolunteerCounts.volunteersOnly || 0],
      [`Both (${memberVolunteerCounts.both || 0})`, memberVolunteerCounts.both || 0]
    ]
    requests.push(buildCellUpdateRequest(metadataSheetId, 0, memberVolunteerHeaders, memberVolunteerRows))

    // Provider service counts by metro area (col D-F)
    if (providerTotals.length > 0) {
      const providerHeaders = ['Metro Area', 'Confirmed', 'Completed']
      const providerTotalConfirmed = providerTotals.reduce((sum, pt) => sum + pt[1], 0)
      const providerTotalCompleted = providerTotals.reduce((sum, pt) => sum + pt[2], 0)
      const providerRows = providerTotals.map(pt => [
        `${pt[0]} (${pt[1] + pt[2]})`,
        pt[1],
        pt[2]
      ])
      requests.push(buildCellUpdateRequest(metadataSheetId, 3, providerHeaders, providerRows))
    }

    // Member request counts by metro area (col H-M with Unmatched)
    if (memberTotals.length > 0) {
      const memberHeaders = ['Metro Area', 'Unmatched', 'Cancelled', 'Open', 'Confirmed', 'Completed']
      const memberRows = memberTotals.map(mt => [
        `${mt[0]} (${mt[3] + mt[4] + mt[5]})`,
        -mt[1],
        -mt[2],
        mt[3],
        mt[4],
        mt[5]
      ])
      requests.push(buildCellUpdateRequest(metadataSheetId, 7, memberHeaders, memberRows))
    }

    // Volunteer Service Categories counts (col N-O)
    if (categoryCounts.length > 0) {
      const categoryHeaders = ['Category', 'Count']
      const categoryRows = categoryCounts.map(cc => [`${cc.name} (${cc.count})`, cc.count])
      requests.push(buildCellUpdateRequest(metadataSheetId, 13, categoryHeaders, categoryRows))
    }

    // Service name counts (col P-U with Unmatched)
    if (serviceCounts.length > 0) {
      const serviceHeaders = ['Service Name', 'Unmatched', 'Cancelled', 'Open', 'Confirmed', 'Completed']
      const serviceRows = serviceCounts.map(sc => [
        `${sc.name} (${sc.open + sc.confirmed + sc.completed})`,
        -sc.unmatched,
        -sc.cancelled,
        sc.open,
        sc.confirmed,
        sc.completed
      ])
      requests.push(buildCellUpdateRequest(metadataSheetId, 15, serviceHeaders, serviceRows))
    }

    if (requests.length > 0) {
      info(`Sending Hub batchUpdate`, { requestCount: requests.length })
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests }
      })
      info(`Hub metadata tab update complete`, { requestCount: requests.length })
    }
  } catch (err) {
    warn(`Failed to update Hub metadata`, { error: err.message })
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

  // Auto-fit columns for all metro area tabs (Members, Volunteers, Requests Open/Confirmed/History)
  // Workaround: reliable auto-fit requires this sequence with delays:
  // 1. Set all column widths to 200px (baseline)
  // 2. Set all cells to Arial 10 using repeatCell (for auto-fit calibration)
  // 3. Apply autoResize (with 5s delay)
  // 4. Set all cells back to Arial 9 using repeatCell (with 5s delay)
  info(`Auto-fitting column widths for metro area tabs`)
  try {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId })
    const tabNames = ['Members', 'Volunteers', 'Requests Open', 'Requests Confirmed', 'Requests History']
    const tabSheets = []

    for (const tabName of tabNames) {
      const sheet = spreadsheet.data.sheets.find(s => s.properties.title === tabName)
      if (sheet) {
        tabSheets.push({ name: tabName, sheetId: sheet.properties.sheetId })
      }
    }

    if (tabSheets.length > 0) {
      // Step 1: Set all column widths to 200px baseline
      info(`Setting column widths to 200px baseline`)
      const setWidthRequests = tabSheets.map(tab => ({
        updateDimensionProperties: {
          range: {
            sheetId: tab.sheetId,
            dimension: 'COLUMNS',
            startIndex: 0
          },
          properties: {
            pixelSize: 200
          },
          fields: 'pixelSize'
        }
      }))
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: setWidthRequests }
      })

      // Step 2: Set all cells to Arial 10 using repeatCell
      info(`Setting font to Arial 10 for auto-fit calibration`)
      const setArialTenRequests = tabSheets.map(tab => ({
        repeatCell: {
          range: {
            sheetId: tab.sheetId,
            startRowIndex: 0,
            startColumnIndex: 0
          },
          cell: {
            userEnteredFormat: {
              textFormat: {
                fontFamily: 'Arial',
                fontSize: 10
              }
            }
          },
          fields: 'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize'
        }
      }))
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: setArialTenRequests }
      })
      await new Promise(resolve => setTimeout(resolve, 1000))

      // Step 3: Apply autoResize (batch all tabs into one request)
      info(`Applying auto-resize dimensions`)
      const autoResizeRequests = tabSheets.map(tab => ({
        autoResizeDimensions: {
          dimensions: { sheetId: tab.sheetId, dimension: 'COLUMNS' }
        }
      }))
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: autoResizeRequests }
      })
      await new Promise(resolve => setTimeout(resolve, 1000))

      // Step 4: Set all cells back to Arial 9 using repeatCell
      info(`Reverting font to Arial 9`)
      const setArialNineRequests = tabSheets.map(tab => ({
        repeatCell: {
          range: {
            sheetId: tab.sheetId,
            startRowIndex: 0,
            startColumnIndex: 0
          },
          cell: {
            userEnteredFormat: {
              textFormat: {
                fontFamily: 'Arial',
                fontSize: 9
              }
            }
          },
          fields: 'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize'
        }
      }))
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: setArialNineRequests }
      })

      info(`Column auto-fit complete with reliable workaround`, { tabCount: tabSheets.length })
    }
  } catch (err) {
    warn(`Failed to auto-fit columns`, { error: err.message })
  }
}

async function syncHub(sheets, spreadsheetId, parsed, emailTimestamp) {
  info(`Starting Hub sync`, {
    hasDumpMember: !!parsed['dump-member'],
    dumpMemberCount: (parsed['dump-member'] || []).length,
    hasDumpServiceProvider: !!parsed['dump-service-provider'],
    dumpServiceProviderCount: (parsed['dump-service-provider'] || []).length,
    hasDumpServiceCategory: !!parsed['dump-service-provider-category'],
    hasDumpServiceRequested: !!parsed['dump-service-requested'],
    dumpServiceRequestedCount: (parsed['dump-service-requested'] || []).length,
    hasDumpServiceConfirmed: !!parsed['dump-service-confirmed'],
    dumpServiceConfirmedCount: (parsed['dump-service-confirmed'] || []).length,
    hasDumpServiceHistory: !!parsed['dump-service-history'],
    dumpServiceHistoryCount: (parsed['dump-service-history'] || []).length,
    hasDumpServiceHistoryUnmatched: !!parsed['dump-service-history-unmatched'],
    dumpServiceHistoryUnmatchedCount: (parsed['dump-service-history-unmatched'] || []).length
  })

  // Global aggregations
  const allMembers = parsed['dump-member'] || []
  const allProviders = parsed['dump-service-provider'] || []
  const allCategories = parsed['dump-service-provider-category'] || []
  const memberVolunteerCounts = getMemberVolunteerCounts(allMembers, allProviders)
  const categoryCounts = getProviderCategoryCounts(allCategories)

  info(`Hub global aggregations complete`, { memberVolunteerCounts, categoryCounts: categoryCounts.length })

  // Per-metro aggregations
  const providerTotals = []
  const memberTotals = []

  for (const metroArea of Object.keys(productionMetroAreas)) {
    const open = (parsed['dump-service-requested'] || []).filter(r => r['Metro Area'] === metroArea)
    const confirmed = (parsed['dump-service-confirmed'] || []).filter(r => r['Metro Area'] === metroArea)
    const historyBase = (parsed['dump-service-history'] || [])
      .filter(r => r['Metro Area'] === metroArea && r['Service Name'] !== 'Member Added')
    const historyUnmatched = (parsed['dump-service-history-unmatched'] || [])
      .filter(r => r['Metro Area'] === metroArea && r['Service Name'] !== 'Member Added')
    const history = [...historyBase, ...historyUnmatched]

    const pCounts = getProviderServiceCounts(history, confirmed)
    providerTotals.push(
      pCounts.reduce((a, r) => [metroArea, a[1] + r.confirmed, a[2] + r.completed], [metroArea, 0, 0])
    )

    const mCounts = getMemberRequestCounts(open, confirmed, history)
    memberTotals.push(
      mCounts.reduce((a, r) => [metroArea, a[1] + r.unmatched, a[2] + r.cancelled, a[3] + r.open, a[4] + r.confirmed, a[5] + r.completed], [metroArea, 0, 0, 0, 0, 0])
    )
  }

  // Service name counts: pivot on service name, sum across all metros
  const allOpen = parsed['dump-service-requested'] || []
  const allConfirmed = parsed['dump-service-confirmed'] || []
  const allHistoryBase = (parsed['dump-service-history'] || []).filter(r => r['Service Name'] !== 'Member Added')
  const allHistoryUnmatched = (parsed['dump-service-history-unmatched'] || []).filter(r => r['Service Name'] !== 'Member Added')
  const allHistory = [...allHistoryBase, ...allHistoryUnmatched]
  const serviceCounts = getServiceNameCounts(allOpen, allConfirmed, allHistory)

  info(`Hub per-metro aggregations complete`, {
    providerTotalsCount: providerTotals.length,
    memberTotalsCount: memberTotals.length,
    serviceCountsCount: serviceCounts.length,
    sampleMemberTotal: memberTotals[0],
    sampleServiceCount: serviceCounts[0]
  })

  const endTime = new Date().toISOString()
  await updateHubMetadata(sheets, spreadsheetId, {
    memberVolunteerCounts,
    categoryCounts,
    providerTotals,
    memberTotals,
    serviceCounts,
    emailTimestampFormatted: formatTimestampEastern(emailTimestamp),
    endTimeFormatted: formatTimestampEastern(endTime)
  })

  info(`Hub sync complete`)
}

export {
  syncTab,
  syncMetroArea,
  syncHub
}
