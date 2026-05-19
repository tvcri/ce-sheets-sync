# Add unmatched request tracking, Hub spreadsheet, and data model refinements

## Unmatched request tracking (new data source)

This branch introduces a new CE report (`dump-service-history-unmatched`) that isolates service requests cancelled with reason "Can't supply a service provider" — these are the unfilled or "unmatched" requests. 

`getMetroAreaData` now merges matched history (`dump-service-history`) and unmatched history into a single `allHistory` array sorted by finish date. The `countByField` function (used by `getMemberRequestCounts` and `getServiceNameCounts`) gains an `unmatched` bucket, with status now driven by the `Status` field value (`completed` / `cancelled` / `unmatched`) rather than presence/absence of a cancellation reason. The Metadata tab's member request counts column now includes an "Unmatched" row.

**Note:** CE report configs (`dump-service-history` and the new `dump-service-history-unmatched`) must be re-imported into Club Express for the new data sources and column changes to take effect.

## Hub spreadsheet

A new `syncHub` function rolls up all metro area data into a single Hub spreadsheet, showing volunteer/member totals, provider service counts by metro, member request counts by metro, category counts, and service name counts.

Hub sync runs before per-metro syncs and can be included/excluded via the `METRO_AREAS` env var (use `Hub` as a value). Setting `DEBUG_HUB_ONLY=true` skips all per-metro syncs for Hub-focused testing.

A new `USE_DEV_SHEETS` env var switches between production and development spreadsheet IDs without code changes. `metro-areas.js` now exports `productionMetroAreas`, `devMetroAreas`, `hubSpreadsheetId`, and `devHubSpreadsheetId`.

## Data model refinements

- `Provider` → `Volunteer` throughout (CE reports, JS processing, tests, fixtures)
- `Cancellation Reason` → `Status` with explicit `Completed` / `Cancelled` / `Unmatched` values
- Destination address fields consolidated into a single `Address` formula column across all CE reports
- TVC metro area excluded from all CE reports (already excluded from metro-areas config)
- Category column names singularized: `Errands` → `Errand`, `Rides` → `Ride` (required for the column auto-fit workaround)

## Template sheets + setup docs

`docs/SETUP.md` now has a "Set Up Your Google Sheets" section with links to two publicly readable template spreadsheets: a Metro Area Template and a Hub Template. Volunteers can **File → Make a copy** of either template and point `devMetroAreas` / `devHubSpreadsheetId` at their copies for safe, isolated testing. The guide also shows the combined `METRO_AREAS` + `TEST_SPREADSHEET_ID` + `CSV_FILE` invocation for end-to-end testing without touching production.

## Column auto-fit workaround + CI

`syncMetroArea` now runs a 4-step resize sequence after each metro sync: set widths to 200px baseline → Arial 10 → 1s delay → autoResize → 1s delay → Arial 9. This reliably fits column widths in Google Sheets.

A GitHub Actions workflow (`.github/workflows/test.yml`) now runs `npm test` on Node 18.x and 20.x for every push and PR to `main`.

---

**Key files changed:**
- `lib/dump-chain-processor.js` — unmatched merge logic, field renames
- `lib/sheets-sync.js` — `syncHub`, `updateHubMetadata`, auto-fit sequence
- `lib/metro-areas.js` — dev/prod split, hub IDs
- `sync.js` — hub-first orchestration, `USE_DEV_SHEETS`, `DEBUG_HUB_ONLY`
- `setup/ce/dump-service-history-unmatched.wrq.wr` — new CE report (new file)
- `docs/SETUP.md` — template sheet links and test workflow (new section)
- `.github/workflows/test.yml` — CI (new file)
