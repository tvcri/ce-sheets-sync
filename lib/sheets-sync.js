import { google } from 'googleapis'
import { info, error, warn } from './logger.js'

class SheetsSyncer {
  #sheets
  #spreadsheetId

  constructor(sheets, spreadsheetId) {
    this.#sheets = sheets
    this.#spreadsheetId = spreadsheetId
  }

  async syncMetroArea(metroData, { emailTimestamp, metroArea }) {
    for (const [tabName, records] of Object.entries(metroData.tabs)) {
      await this.#syncTab({
        tabName,
        records,
        providerNames: metroData.providerNames,
        metroArea,
        memberNames: metroData.memberNames
      })
    }

    const endTime = new Date().toISOString()
    await this.#updateMetadata({
      providerCounts: metroData.providerCounts,
      memberCounts: metroData.memberCounts,
      categoryCounts: metroData.categoryCounts,
      serviceCounts: metroData.serviceCounts,
      memberVolunteerCounts: metroData.memberVolunteerCounts,
      emailTimestampFormatted: this.#formatTimestampEastern(emailTimestamp),
      endTimeFormatted: this.#formatTimestampEastern(endTime),
      metroArea
    })

    // Auto-fit columns for all metro area tabs
    info(`Auto-fitting column widths for metro area tabs`, { metroArea })
    try {
      const spreadsheet = await this.#sheets.spreadsheets.get({ spreadsheetId: this.#spreadsheetId })
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
        await this.#retryWithBackoff(() => this.#sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.#spreadsheetId,
          requestBody: { requests: setWidthRequests }
        }))

        // Step 2: Set all cells to Arial 10 using repeatCell
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
        await this.#retryWithBackoff(() => this.#sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.#spreadsheetId,
          requestBody: { requests: setArialTenRequests }
        }))
        await new Promise(resolve => setTimeout(resolve, 1000))

        // Step 3: Apply autoResize
        const autoResizeRequests = tabSheets.map(tab => ({
          autoResizeDimensions: {
            dimensions: { sheetId: tab.sheetId, dimension: 'COLUMNS' }
          }
        }))
        await this.#retryWithBackoff(() => this.#sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.#spreadsheetId,
          requestBody: { requests: autoResizeRequests }
        }))
        await new Promise(resolve => setTimeout(resolve, 1000))

        // Step 4: Set all cells back to Arial 9 using repeatCell
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
        await this.#retryWithBackoff(() => this.#sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.#spreadsheetId,
          requestBody: { requests: setArialNineRequests }
        }))
      }
    } catch (err) {
      warn(`Failed to auto-fit columns`, { error: err.message })
    }
  }

  async syncHub(hubData, emailTimestamp) {
    const endTime = new Date().toISOString()
    await this.#updateHubMetadata({
      ...hubData,
      emailTimestampFormatted: this.#formatTimestampEastern(emailTimestamp),
      endTimeFormatted: this.#formatTimestampEastern(endTime)
    })
    info(`Hub sync complete`)
  }

  async #syncTab({ tabName, records, providerNames = new Set(), metroArea = null, memberNames = new Set() }) {
    if (records.length === 0) {
      info(`Clearing empty tab`, { tabName, ...(metroArea && { metroArea }) })
      await this.#sheets.spreadsheets.values.clear({
        spreadsheetId: this.#spreadsheetId,
        range: `${tabName}!A:Z`
      })
      return
    }

    info(`Syncing tab`, { tabName, recordCount: records.length, ...(metroArea && { metroArea }) })

    const headers = Object.keys(records[0])
    const isMemberIdx = headers.indexOf('IsMember')
    const isVolunteerIdx = headers.indexOf('Is volunteer')
    const yesNoColumns = ['Has smartphone', 'Has computer']
    const yesNoIndices = yesNoColumns.map(col => headers.indexOf(col)).filter(idx => idx >= 0)
    const zipIdx = headers.indexOf('Zip')

    const rows = [headers, ...records.map(r => headers.map((h, colIdx) => {
      const value = r[h] || ''
      if (tabName === 'Members' && colIdx === isVolunteerIdx) {
        return providerNames.has(r['Name'].trim()) ? '✓' : ''
      }
      if (colIdx === isMemberIdx) {
        return memberNames.has(r['Name'].trim()) ? '✓' : ''
      }
      if (yesNoIndices.includes(colIdx)) {
        return value === 'Yes' ? '✓' : ''
      }
      if (colIdx === zipIdx && value) {
        return value.padStart(5, '0')
      }
      return value
    }))]

    await this.#sheets.spreadsheets.values.clear({
      spreadsheetId: this.#spreadsheetId,
      range: `${tabName}!A:Z`
    })

    await this.#sheets.spreadsheets.values.update({
      spreadsheetId: this.#spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: rows
      }
    })
  }

  #formatTimestampEastern(timestamp) {
    const date = new Date(timestamp)
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

  #buildTimestampRequests(metadataSheetId, dashboardSheetId, emailTimestampFormatted, endTimeFormatted) {
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

  #buildCellUpdateRequest(metadataSheetId, startColumnIndex, headers, rows) {
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

  async #updateMetadata(metadata) {
    const {
      providerCounts = [],
      memberCounts = [],
      categoryCounts = [],
      serviceCounts = [],
      memberVolunteerCounts = {},
      emailTimestampFormatted = '',
      endTimeFormatted = '',
      metroArea = null
    } = metadata

    try {
      info(`Updating metadata tab`, ...(metroArea ? [{ metroArea }] : [{}]))
      const spreadsheet = await this.#sheets.spreadsheets.get({ spreadsheetId: this.#spreadsheetId })

      const metadataSheet = spreadsheet.data.sheets.find(s => s.properties.title === 'Metadata' || s.properties.title === '🕐')
      const dashboardSheet = spreadsheet.data.sheets.find(s => s.properties.title === 'Dashboard')

      if (!metadataSheet) {
        warn(`Metadata tab not found, skipping dashboard setup`)
        return
      }

      const metadataSheetId = metadataSheet.properties.sheetId
      const requests = []

      requests.push({
        updateCells: {
          range: {
            sheetId: metadataSheetId,
            startRowIndex: 40,
            startColumnIndex: 0,
            endRowIndex: 1000,
            endColumnIndex: 21
          },
          rows: [],
          fields: 'userEnteredValue'
        }
      })

      const dashboardSheetId = dashboardSheet ? dashboardSheet.properties.sheetId : null
      requests.push(...this.#buildTimestampRequests(metadataSheetId, dashboardSheetId, emailTimestampFormatted, endTimeFormatted))

      // Member/Volunteer/Both counts
      const memberVolunteerHeaders = ['Category', 'Count']
      const memberVolunteerRows = [
        [`Members (${memberVolunteerCounts.membersOnly || 0})`, memberVolunteerCounts.membersOnly || 0],
        [`Volunteers (${memberVolunteerCounts.volunteersOnly || 0})`, memberVolunteerCounts.volunteersOnly || 0],
        [`Both (${memberVolunteerCounts.both || 0})`, memberVolunteerCounts.both || 0]
      ]
      requests.push(this.#buildCellUpdateRequest(metadataSheetId, 0, memberVolunteerHeaders, memberVolunteerRows))

      if (providerCounts.length > 0) {
        const headers = ['Provider', 'Confirmed', 'Completed']
        const rows = providerCounts.map(pc => [pc.name, pc.confirmed, pc.completed])
        requests.push(this.#buildCellUpdateRequest(metadataSheetId, 3, headers, rows))
      }

      if (memberCounts.length > 0) {
        const headers = ['Member', 'Unmatched', 'Cancelled', 'Open', 'Confirmed', 'Completed']
        const rows = memberCounts.map(mc => [mc.name, -mc.unmatched, -mc.cancelled, mc.open, mc.confirmed, mc.completed])
        requests.push(this.#buildCellUpdateRequest(metadataSheetId, 7, headers, rows))
      }

      if (categoryCounts.length > 0) {
        const headers = ['Category', 'Count']
        const rows = categoryCounts.map(cc => [`${cc.name} (${cc.count})`, cc.count])
        requests.push(this.#buildCellUpdateRequest(metadataSheetId, 13, headers, rows))
      }

      if (serviceCounts.length > 0) {
        const headers = ['Service Name', 'Unmatched', 'Cancelled', 'Open', 'Confirmed', 'Completed']
        const rows = serviceCounts.map(sc => [`${sc.name} (${sc.open + sc.confirmed + sc.completed})`, -sc.unmatched, -sc.cancelled, sc.open, sc.confirmed, sc.completed])
        requests.push(this.#buildCellUpdateRequest(metadataSheetId, 15, headers, rows))
      }

      if (requests.length > 0) {
        await this.#sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.#spreadsheetId,
          requestBody: { requests }
        })
      }
    } catch (err) {
      warn(`Failed to setup dashboard`, { error: err.message })
    }
  }

  async #updateHubMetadata(hubData) {
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
      const spreadsheet = await this.#sheets.spreadsheets.get({ spreadsheetId: this.#spreadsheetId })

      const metadataSheet = spreadsheet.data.sheets.find(s => s.properties.title === 'Metadata' || s.properties.title === '🕐')
      const dashboardSheet = spreadsheet.data.sheets.find(s => s.properties.title === 'Dashboard')

      if (!metadataSheet) {
        warn(`Metadata tab not found, skipping Hub metadata update`)
        return
      }

      const metadataSheetId = metadataSheet.properties.sheetId
      const requests = []

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
      requests.push(...this.#buildTimestampRequests(metadataSheetId, dashboardSheetId, emailTimestampFormatted, endTimeFormatted))

      const memberVolunteerHeaders = ['Category', 'Count']
      const memberVolunteerRows = [
        [`Members (${memberVolunteerCounts.membersOnly || 0})`, memberVolunteerCounts.membersOnly || 0],
        [`Volunteers (${memberVolunteerCounts.volunteersOnly || 0})`, memberVolunteerCounts.volunteersOnly || 0],
        [`Both (${memberVolunteerCounts.both || 0})`, memberVolunteerCounts.both || 0]
      ]
      requests.push(this.#buildCellUpdateRequest(metadataSheetId, 0, memberVolunteerHeaders, memberVolunteerRows))

      if (providerTotals.length > 0) {
        const providerHeaders = ['Metro Area', 'Confirmed', 'Completed']
        const providerRows = providerTotals.map(pt => [
          `${pt[0]} (${pt[1] + pt[2]})`,
          pt[1],
          pt[2]
        ])
        requests.push(this.#buildCellUpdateRequest(metadataSheetId, 3, providerHeaders, providerRows))
      }

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
        requests.push(this.#buildCellUpdateRequest(metadataSheetId, 7, memberHeaders, memberRows))
      }

      if (categoryCounts.length > 0) {
        const categoryHeaders = ['Category', 'Count']
        const categoryRows = categoryCounts.map(cc => [`${cc.name} (${cc.count})`, cc.count])
        requests.push(this.#buildCellUpdateRequest(metadataSheetId, 13, categoryHeaders, categoryRows))
      }

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
        requests.push(this.#buildCellUpdateRequest(metadataSheetId, 15, serviceHeaders, serviceRows))
      }

      if (requests.length > 0) {
        await this.#sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.#spreadsheetId,
          requestBody: { requests }
        })
        info(`Hub metadata tab update complete`, { requestCount: requests.length })
      }
    } catch (err) {
      warn(`Failed to update Hub metadata`, { error: err.message })
    }
  }

  async #retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 1000) {
    let lastErr
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        const isQuotaError = err.message?.includes('Quota exceeded') || err.message?.includes('quota')
        if (!isQuotaError || attempt === maxRetries - 1) throw err
        const delayMs = baseDelayMs * Math.pow(2, attempt)
        warn(`Quota exceeded, retrying in ${delayMs}ms`, { attempt: attempt + 1, maxRetries })
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }
    throw lastErr
  }
}

export { SheetsSyncer }
