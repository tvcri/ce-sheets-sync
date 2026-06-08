# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This System Does

An ETL pipeline that pulls Club Express (CE) membership/volunteer/service-request data from an automated email, parses a multi-section CSV dump, and syncs structured data to per-metro-area Google Sheets. Currently 14 metro areas, each with its own spreadsheet. Also maintains a Hub spreadsheet that aggregates cross-metro metrics.

## Project Status

The repo is ready for volunteer maintainers. Public-facing files:
- **`README.md`** — Overview and quick links to guides
- **`docs/`** — Five detailed guides (Setup, Env Vars, Scheduling, Google OAuth, Troubleshooting)
- **`.env.example`** — Annotated template with all configuration options
- **`flow-diagram.svg`** — Visual data flow diagram
- **`sync.js`** — Entry point (run directly via cron/Task Scheduler)
- **`lib/`** — Core library modules
- **`setup/ce/`** — ClubExpress report definitions (XML config, can be re-imported to CE)
- **`.github/workflows/`** — GitHub Actions CI (runs tests on Node.js 18.x, 20.x, 22.x LTS)
- **`scratch/`** — Dev-only scripts and artifacts (gitignored, not in shared repo)

## Architecture

```
sync.js                             Entry point (IMAP poll → email → CSV → syncSheets)
  ├── imports from lib/dump-chain-processor.js   (CSV parsing → DumpChainData)
  ├── imports from lib/sheets-sync.js            (SheetsSyncer: Google Sheets write layer)
  ├── imports from lib/logger.js                 (structured JSON logging)
  └── imports from lib/metro-areas.js            (metro area → spreadsheet ID config)

lib/                                Core library (reusable, isolated layers)
  ├── logger.js                     info/warn/error/debug → JSON stdout
  ├── metro-areas.js                Production/dev metro areas & Hub IDs (single source of truth)
  ├── dump-chain-processor.js       CSV → DumpChainData (pure data transformation, no I/O)
  │   └── export: DumpChainData class
  │       ├── static from(csvContent)           Parse CSV → DumpChainData instance
  │       ├── hasMetroArea(metroArea)           Check if metro exists in CSV
  │       ├── metroAreas()                      Sorted list of all metros in CSV
  │       ├── getMetroAreaData(metroArea)       Filtered + aggregated data for one metro (tabs + analytics)
  │       ├── getHubData(metroAreas)            Cross-metro aggregations (providerTotals, memberTotals, etc.)
  │       └── .parsed getter                    Raw sections (internal; for backward compat)
  │
  │   Internal (private) functions:
  │   ├── formatDateToISO(dateString)           Parse various formats → ISO
  │   ├── convertToDisplayFormat(dateStr)       ISO → 12-hour AM/PM display
  │   ├── splitDumpChain(csvContent)            Split multi-section CSV by "dump-*" headers
  │   ├── parseSection(sectionContent)          csv-parse → array of objects
  │   ├── parseDumpChain(csvContent)            Combine sections → { "dump-member": [...], ... }
  │   ├── removeMetroAreaColumn(records)        Remove after filtering by metro
  │   ├── flattenProviderCategories()           Dynamically discover + pivot categories
  │   ├── getProviderServiceCounts()            Volunteer counts by service type
  │   ├── getMemberRequestCounts()              Member counts by request type (incl. unmatched)
  │   ├── getProviderCategoryCounts()           Volunteer counts by category
  │   ├── getServiceNameCounts()                Service counts by name (incl. unmatched)
  │   ├── getMemberVolunteerCounts()            Member/volunteer reconciliation (membersOnly, volunteersOnly, both)
  │   └── getHubData(parsed, metroAreas)        Private impl; called by DumpChainData.getHubData()
  │
  └── sheets-sync.js                Google Sheets write layer (SheetsSyncer class, no data transformation)
      └── export: SheetsSyncer class
          ├── constructor(sheetsClient, spreadsheetId)
          ├── async syncMetroArea(metroData, {emailTimestamp, metroArea})
          ├── async syncHub(hubData, emailTimestamp)
          └── Private methods: #syncTab, #updateMetadata, #updateHubMetadata, #retryWithBackoff, etc.

setup/ce/                           ClubExpress report XML definitions
                                    These are exported from Club Express and loaded back into the tool.
                                    They define the multi-section CSV dump that sync.js consumes.
                                    Not executed by JavaScript — they configure the Club Express platform.
```

**Data flow:** IMAP polling → email with CSV → DumpChainData.from(csv) → getMetroAreaData() + getHubData() → SheetsSyncer.syncMetroArea() + syncHub() → Google Sheets

## Running

**No build step.** This is plain Node ESM.

```bash
# Install dependencies
npm install

# Run tests (Node.js built-in test runner)
npm test

# Run the IMAP poller (checks email every 30s for Club Express dump)
# Requires EMAIL_ADDRESS, EMAIL_PASSWORD, and Google OAuth tokens in tokens/
node sync.js

# Or process a local CSV file directly
CSV_FILE=path/to/dump-chain.csv node sync.js

# Or sync only specific metro areas (or Hub)
METRO_AREAS="Aquidneck,Providence" node sync.js
METRO_AREAS="Hub" node sync.js

# Test with a single metro area against a test spreadsheet
METRO_AREAS="Aquidneck" TEST_SPREADSHEET_ID=1scZUjk032Uog7F5f7DiPqABeUuTqyllAKGJKDumw8L0 node sync.js

# Use development spreadsheets instead of production
USE_DEV_SHEETS=true node sync.js

# Skip per-metro syncs, Hub only
DEBUG_HUB_ONLY=true node sync.js
```

**Logging:** `sync.js` uses `lib/logger.js`, which writes structured JSON to stdout. Useful for grepping specific fields:
```bash
node sync.js 2>&1 | grep '"level":"error"'
```

## Known Issues in `lib/` (Shared Repo)

These are in the code that will be part of the shared repository.

**1. Column positions in `updateMetadata()` are magic numbers** (sheets-sync.js)

Uses `startColumnIndex` constants for member request counts, provider service counts, provider category counts, and service name counts. These map to specific columns in the Metadata tab (row 40 onwards). The blocks are tightly packed (contiguous columns).

**Design note:** Existing charts use contiguous column layout (no gaps). This was fragile during development when data ranges changed. **Future charts should use fixed offset spacing** (e.g., every chart starts 10 columns apart) for maintainability. Define column positions as named constants when adding new chart blocks.

**2. CE report configs need re-import to Club Express**

When `dump-service-history`, `dump-service-history-unmatched`, `dump-service-confirmed`, and other report definitions change, they must be re-imported into Club Express via the Platform → Report Builder. Changes to column order, filters, or formulas in these reports are not effective until re-imported.

## Test Coverage

**33 tests** (Node.js built-in test runner) covering all public API and behaviors:

All tests use `DumpChainData.from(csvContent)` with fixture data. No direct function imports.

- `DumpChainData.from()` — CSV parsing, error handling (empty CSV)
- `DumpChainData.hasMetroArea()` — presence checks
- `DumpChainData.metroAreas()` — sorted list of metros in CSV
- `DumpChainData.getMetroAreaData()` — date formatting (ISO and display), section filtering, category flattening, cross-section name sets (providerNames, memberNames), SRLog filtering, 'Member Added' exclusion
- `DumpChainData.getMetroAreaData() analytics` — providerCounts, memberCounts, categoryCounts, serviceCounts, memberVolunteerCounts
- `DumpChainData.getHubData()` — cross-metro aggregations (memberVolunteerCounts, categoryCounts, providerTotals, memberTotals, serviceCounts)

Fixture-based approach: tests create targeted CSV strings with only the data needed for each scenario. This makes tests resilient to internal refactoring (private functions can change without breaking tests).

Run with `npm test`. All tests pass. Tests run automatically on Node.js 18.x, 20.x, 22.x via GitHub Actions on push/PR to main.

## What's Done

✅ Architecture documented (CLAUDE.md) — clean separation: transform / write / orchestrate  
✅ DumpChainData class with stable public API — single export, reusable, no Sheets coupling  
✅ SheetsSyncer class — pure write layer, no data transformation, testable  
✅ Modular, reusable code — `dump-chain-processor.js` portable to MySQL, API endpoints, batch jobs  
✅ Test redesign (33 tests) — fixture-based, API-driven, resilient to internal changes  
✅ Full test coverage for all core behaviors (33 tests)  
✅ Public documentation (README, 5 guides, flow diagram)  
✅ Environment variable guide with examples  
✅ Setup and troubleshooting docs for volunteers  
✅ Unmatched request tracking (new CE report, merged into history)  
✅ Hub spreadsheet for cross-metro aggregation  
✅ Data model refinements (Provider → Volunteer, Cancellation Reason → Status)  
✅ Template sheets for safe testing by volunteers  
✅ Column auto-fit workaround for reliable Google Sheets formatting  
✅ GitHub Actions CI (Node.js 18.x, 20.x, 22.x LTS)  
✅ Fixed dev metro areas support — `getHubData(metroAreas)` accepts any config  

**Known limitation:** Magic column numbers in `updateMetadata()`. Use fixed offset spacing (10+ columns apart) when adding new chart blocks. CE report configs must be re-imported to Club Express when changed.

## Shared vs. Scratch

- **Shared repo (published):** `README.md`, `docs/`, `.env.example`, `flow-diagram.svg`, `sync.js`, `lib/`, `setup/ce/`, `package.json`, `test/`
- **Scratch (gitignored, dev-only):** `/scratch/` — sample CSVs, dev scripts, one-time setup tools

The repo is ready for volunteers. Don't add complexity to shared code without a strong reason.

## Before Touching Code

**Understand the architecture — clean separation of concerns:**
- `dump-chain-processor.js` — Pure data transformation. CSV in → structured arrays/objects out. No I/O, no Google Sheets knowledge. Stateless, reusable (e.g., can be used for MySQL sync without modification).
- `sheets-sync.js` — Pure write layer. Accepts DumpChainData outputs (metroData, hubData) and writes to Sheets via API. No data transformation, no computation, no CSV parsing.
- `sync.js` — Orchestrator. IMAP polling, error handling, retry logic, config validation. Glues together DumpChainData and SheetsSyncer.

**Extending the module:**
- Add new aggregations? Add them to `dump-chain-processor.js` (private function) and expose via `DumpChainData.getXxxData()` method.
- Change how data is written to Sheets? Modify `SheetsSyncer` methods.
- Change metro area configuration? No changes needed; pass different metroAreas object to `DumpChainData.getHubData()`.

**Backwards compatibility:**
- Changes to `DumpChainData` output affect all 14 metro area spreadsheets and the Hub spreadsheet
- Test with at least one real metro area before merging
- Don't break existing spreadsheet structure (columns, tabs) without understanding the impact
- CE report config changes require re-import to Club Express for changes to take effect
- Data model changes (field names, status values) may require spreadsheet updates if volunteers have custom logic

**Testing:** All tests use `DumpChainData.from(csv)` with fixture data and verify behavior through public API. No direct function testing. This makes tests resilient to internal refactoring.

## ESM Notes

This is an ESM project (`"type": "module"` in package.json). All imports use `import` syntax, never `require()`.
