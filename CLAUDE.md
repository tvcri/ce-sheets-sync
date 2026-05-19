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
  ├── imports from lib/dump-chain-processor.js   (CSV parsing, data transformation)
  ├── imports from lib/sheets-sync.js            (Google Sheets write layer)
  ├── imports from lib/logger.js                 (structured JSON logging)
  └── imports from lib/metro-areas.js            (metro area → spreadsheet ID config)

lib/                                Core library (reusable, pure functions for lib/dump-chain-processor.js)
  ├── logger.js                     info/warn/error/debug → JSON stdout
  ├── metro-areas.js                Production/dev metro areas & Hub IDs (single source of truth)
  ├── dump-chain-processor.js       CSV parsing + data transformation (pure functions, no I/O)
  │   ├── splitDumpChain(csvContent)            Split multi-section CSV by "dump-*" headers
  │   ├── parseSection(sectionContent)          csv-parse/sync → array of objects
  │   ├── parseDumpChain(csvContent)            Combine all sections → { "dump-member": [...], ... }
  │   ├── getMetroAreaData(parsed, metroArea)   Filter by metro area, format dates, flatten categories
  │   ├── flattenProviderCategories()           Dynamically discover all categories and pivot them
  │   ├── getProviderServiceCounts()            Aggregate volunteer counts by service type
  │   ├── getMemberRequestCounts()              Aggregate member counts by request type (incl. unmatched)
  │   ├── getProviderCategoryCounts()           Aggregate volunteer counts by category (hardcoded list)
  │   ├── getServiceNameCounts()                Aggregate service counts by name (incl. unmatched)
  │   └── formatDateToISO(dateString)           Parse various date formats → ISO string
  │
  └── sheets-sync.js                Google Sheets write layer
      ├── syncTab(tabName, rows, metroArea)     Clear range A:Z, write headers + rows via Sheets API
      ├── syncMetroArea(metroArea)              Orchestrate 5× syncTab() calls + auto-fit + updateMetadata()
      ├── updateMetadata(metroArea)             Write counts/analytics to "🕐" / "Metadata" tab
      └── syncHub()                 Aggregate and write cross-metro data to Hub spreadsheet

setup/ce/                           ClubExpress report XML definitions
                                    These are exported from Club Express and loaded back into the tool.
                                    They define the multi-section CSV dump that sync.js consumes.
                                    Not executed by JavaScript — they configure the Club Express platform.
```

**Data flow:** IMAP polling → email with CSV attachment → splitDumpChain() → parseSection() → parseDumpChain() → syncHub() + syncMetroArea() for each metro → 5× syncTab() + auto-fit + updateMetadata()

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

**49 tests** (Node.js built-in test runner) covering all core functions:

- `formatDateToISO()` — date parsing across multiple formats
- `splitDumpChain()` — CSV multi-section splitting
- `parseSection()` — CSV parsing per section
- `parseDumpChain()` — full CSV pipeline
- `getMetroAreaData()` — filtering, transformation, category flattening, unmatched history merge
- `flattenProviderCategories()` — dynamic category discovery (singularized names)
- `getProviderServiceCounts()` — volunteer count aggregation
- `getMemberRequestCounts()` — member count aggregation including unmatched
- `getProviderCategoryCounts()` — volunteer category counts
- `getServiceNameCounts()` — service aggregation including unmatched
- `getMemberVolunteerCounts()` — member/volunteer reconciliation
- `per-metro aggregation integrity` — syncHub loop logic, cross-metro counting

Run with `npm test`. All tests pass. Tests run automatically on Node.js 18.x, 20.x, 22.x via GitHub Actions on push/PR to main.

## What's Done

✅ Architecture documented (CLAUDE.md)  
✅ Full test coverage for all core functions (49 tests)  
✅ Code cleanup and readability (all tests pass)  
✅ Public documentation (README, 5 guides, flow diagram)  
✅ Environment variable guide with examples  
✅ Setup and troubleshooting docs for volunteers  
✅ Unmatched request tracking (new CE report, merged into history)  
✅ Hub spreadsheet for cross-metro aggregation  
✅ Data model refinements (Provider → Volunteer, Cancellation Reason → Status)  
✅ Template sheets for safe testing by volunteers  
✅ Column auto-fit workaround for reliable Google Sheets formatting  
✅ GitHub Actions CI (Node.js 18.x, 20.x, 22.x LTS)  

**Known limitation:** Magic column numbers in `updateMetadata()`. Use fixed offset spacing (10+ columns apart) when adding new chart blocks. CE report configs must be re-imported to Club Express when changed.

## Shared vs. Scratch

- **Shared repo (published):** `README.md`, `docs/`, `.env.example`, `flow-diagram.svg`, `sync.js`, `lib/`, `setup/ce/`, `package.json`, `test/`
- **Scratch (gitignored, dev-only):** `/scratch/` — sample CSVs, dev scripts, one-time setup tools

The repo is ready for volunteers. Don't add complexity to shared code without a strong reason.

## Before Touching Code

**Understand the concern:**
- `dump-chain-processor.js` — pure logic, testable, no I/O
- `sheets-sync.js` — I/O layer (Sheets API), depends on dump-chain-processor
- `sync.js` — orchestrator, IMAP polling, retries, timing

**Backwards compatibility:**
- Changes to `dump-chain-processor.js` output affect all 14 metro area spreadsheets and the Hub spreadsheet
- Test with at least one real metro area before merging
- Don't break existing spreadsheet structure (columns, tabs) without understanding the impact
- CE report config changes require re-import to Club Express for changes to take effect
- Data model changes (field names, status values) may require spreadsheet updates if volunteers have custom logic

## ESM Notes

This is an ESM project (`"type": "module"` in package.json). All imports use `import` syntax, never `require()`.
