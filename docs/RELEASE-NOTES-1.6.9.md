# v1.6.9

This release comes out of a clean-environment install test: a new environment, the released zips,
and the setup guide followed as written. It fixes what that test found, ships a reference solution
that imports, and adds installer scripts.

## Upgrade notes

- Import order is now **control first, then reference solution**. The reference solution includes a
  form that hosts the control.
- After upgrading the control, clear the browser's site data for your Dynamics URL. Browsers keep
  the old bundle otherwise.
- New optional property: `defaultMapCenter`.

## Assets

| File | Import into |
| --- | --- |
| `SalesVisitPlanner_managed.zip` | Test and production. The control. Import first. |
| `SalesVisitPlanner.zip` | Development. |
| `SalesVisitPlannerReference_managed.zip` | Test and production. Data model, form, and app. Import second. |
| `SalesVisitPlannerReference.zip` | Development. |

## Reference solution 1.0.1.0

The 1.0.0.0 reference solution did not import: it declared a dependency on its own table and
lacked the `vis_plannercanvas` column the setup guide binds the control to. 1.0.1.0:

- Imports cleanly into an empty environment (tested by deleting every component and reinstalling).
- Includes the `vis_plannercanvas` column.
- Includes the Sales Visit Plan **Information** form with the control already on it. The Azure Maps
  key is blank; you add yours.
- Includes a **Sales Visit Planner** model-driven app.

This replaces the earlier schema-only design. To keep your own form, skip the reference solution
and use `installer/Install-Schema.ps1` or your own tables.

## Installer scripts (new)

- `installer/Install-Schema.ps1` builds the data model from `reference-schema.json` into an
  unmanaged solution. Idempotent.
- `installer/Import-SampleData.ps1` loads a fictional sample day from `sample-data.json`: eight
  accounts, four contacts, one plan, four visits. Re-runnable, and it resets the control's
  write-back fields so a demo can be replayed.

## Fixes

**Routing**
- Route requests sent invalid output options, so every call fell back to the older API and leg
  times were parsed from the wrong part of the response. Routes now use the current API, optimize
  for fastest time, and read per-leg drive times correctly.
- Applying an optimized order failed with HTTP 400 when any candidate column was missing. Columns
  are now probed one at a time and cached.

**Empty and new plans**
- An empty plan replaced the whole panel, hiding the buttons needed to add a visit. The header now
  stays, with guidance and an **Open territory insights** button.
- The map defaulted to a hardcoded position. It now uses `defaultMapCenter`, or a northern Europe
  view when blank.

**Territory insights and prospects**
- **Add to plan** linked the visit to the wrong field, so added visits never appeared. They now
  bind to the plan lookup.
- Added visits were scheduled from the current time. They now go after the plan's last visit, or at
  work-day start.
- The plan view refreshes after adding, and the territory legend no longer stays on the map.

**Priority visits**
- The URGENT badge and highlight did not show in the timeline layout. Fixed.
- **Move to Top & Recalculate** changed nothing, because the timeline sorts by time. It now
  reschedules the open visits from the earliest open slot, keeps each visit's duration, and saves
  the new times and visit order.

**Other**
- Visits with no usable address were dropped from the map without a word. Their cards now show a
  **Not on map** badge.
- Prospect search logged the Azure Maps request URL, key included, to the browser console. The key
  is now redacted.

## Known limits

- Choice option values are compiled into the control. Hand-built choice columns must use the values
  in [SETUP.md section 9](https://github.com/SigridBergWallin/sales-visit-planner-pcf/blob/main/docs/SETUP.md#9-choice-values).
- Sending invitations sets the plan to Completed. The form shows the old status until refreshed.
- Emails stay Pending Send unless the sending user has a synchronized mailbox.
- The header drive time (route service) and the Optimize dialog (route matrix) can differ by a few
  minutes.
- The priority notification hides after 30 seconds; the control checks for new priority visits
  every 60 seconds.
- `vis_lastvisitdate` is read, never written. Populate it with your own process.
