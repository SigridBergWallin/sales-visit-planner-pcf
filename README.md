# Sales Visit Planner (PCF)

A model-driven Power Apps code component that turns a day's appointments into an optimized field-sales route. It shows today's visits in a split panel: a scheduled list on the left and an interactive Azure Maps view on the right, with drive-time estimates, route optimization, a visit-order timeline, invitation tracking, and a Territory Insights view of nearby accounts.

Every table, column, and relationship name the control touches is exposed as a manifest configuration property. The defaults match the reference data model, so the control works out of the box against that schema and can be pointed at a different schema without changing code. Choice option values are the exception: they are fixed (see [Choice values that must align](#choice-values-that-must-align)).

> Control identity: `vis_FieldSales.SalesVisitPlanner`

---

## Features

- Split-panel layout: scheduled appointment list beside a live Azure Maps map
- Route optimization with per-leg and total drive-time roll-up
- Visit-order timeline with priority flags
- Invitation status tracking (not sent, invitation sent, accepted, declined)
- Territory Insights: nearby accounts ranked by last-visit date
- Prospect search to add unplanned accounts and leads to the day
- Geocoding biased to a configurable set of countries

---

## Screenshots

| Visit plan and map | Territory insights |
| --- | --- |
| ![Visit plan and optimised route on the map](images/visit-plan.png) | ![Territory insights panel](images/territory-insights.png) |

---

## Prerequisites

1. **Azure Maps account.** Create one in the Azure portal and copy a subscription key. You supply the key through the `azureMapsKey` property; no key ships with the control. If the Maps account has CORS rules, add your Dynamics URL to the allowed origins.
2. **Model-driven app.** The control reads form context and calls the Dataverse Web API, so canvas apps and Power Pages are not supported.
3. **Data model.** Import the reference solution, script it with `installer/Install-Schema.ps1`, or map the control onto your own tables.

---

## Installation

Download the zips from [Releases](../../releases/latest).

| Solution | Version | What it contains |
|---|---|---|
| `SalesVisitPlanner` | 1.6.9 | The PCF control. |
| `SalesVisitPlannerReference` | 1.0.1.0 | The data model, a Sales Visit Plan form that already hosts the control, and a **Sales Visit Planner** model-driven app. |

1. Import `SalesVisitPlanner_managed.zip`.
2. Import `SalesVisitPlannerReference_managed.zip`. It depends on the control, so the order matters.
3. Open the Sales Visit Plan **Information** form, select the Planner component, paste your key into **Azure Maps Key**, and publish.
4. Optional: load a fictional sample day with `installer/Import-SampleData.ps1`.

[docs/SETUP.md](docs/SETUP.md) covers all three install paths, the sample data, a smoke test, and rollback.

### Installer scripts

| Script | What it does |
| --- | --- |
| `installer/Install-Schema.ps1` | Builds the data model from `reference-schema.json` into an unmanaged solution. Idempotent. Use it to change the prefix or names. |
| `installer/Import-SampleData.ps1` | Loads accounts, contacts, a plan, and visits from `sample-data.json`. Re-runnable; resets what the control writes back, so you can replay a demo. |

Both read their content from JSON. Swap the JSON for a different territory or industry; the scripts stay the same.

---

## Data model

The control reads and writes the following schema. Names shown are the reference defaults; each is overridable through the matching configuration property (see the next section).

### Sales Visit Plan table (custom)

| Purpose | Default logical name | Type |
| --- | --- | --- |
| The visit plan table | `vis_salesvisitplan` | Custom table |
| Entity set / collection (for OData bind) | `vis_salesvisitplans` | (collection name) |
| Work-day start (date sets the plan day) | `vis_starttime` | Date and time |
| Work-day end | `vis_workdayend` | Date and time |
| Plan status | `vis_status` | Choice |
| Optimized total drive minutes | `vis_new_totaldriveminutes` | Whole number |
| Placeholder the control is bound to | `vis_plannercanvas` | Text |

### Appointment table (standard, extended)

The standard `appointment` activity, extended with:

| Purpose | Default logical name | Type |
| --- | --- | --- |
| Priority visit flag | `vis_new_ispriority` | Boolean |
| Optimized visit order | `vis_new_visitorder` | Whole number |
| Invitation status | `vis_new_invitationstatus` | Choice |
| Lookup to the visit plan | `vis_new_salesvisitplanid` | Lookup to `vis_salesvisitplan` |
| Relationship / navigation property | `vis_new_salesvisitplanid_Appointment` | (used for `@odata.bind` and unlink) |

### Account table (standard, extended)

| Purpose | Default logical name | Type |
| --- | --- | --- |
| Last visit date | `vis_lastvisitdate` | Date and time |

### Choice values that must align

The invitation and plan status option values are compiled into the control. The reference solution provisions them. If you create your own choice columns instead, use these exact values.

**Invitation status**

| Label | Value |
| --- | --- |
| Not Sent | 100000000 |
| Invitation Sent (shown as an **Invited** pill) | 100000001 |
| Accepted | 100000002 |
| Declined | 100000003 |

**Plan status**

| Label | Value | Used by the control |
| --- | --- | --- |
| Draft | 100000000 | |
| Active | 100000001 | yes |
| Completed | 100000002 | yes |
| Cancelled | 100000003 | |
| In Progress | 100000004 | |

The reference solution ships all five so the column is useful for your own process, but the control only branches on Active and Completed.

---

## Configuration properties

Set these when you add the control to the form. Every schema property is optional and falls back to the reference default, so an install against the reference data model only needs `azureMapsKey`.

| Property | Required | Default | Description |
| --- | --- | --- | --- |
| `boundField` | Yes | (none) | The text column the control is bound to. |
| `azureMapsKey` | Yes | (none) | Azure Maps subscription key. |
| `recordId` | No | (auto) | Visit plan record id. Auto-detected from form context. |
| `planTable` | No | `vis_salesvisitplan` | Logical name of the visit plan table. |
| `planCollection` | No | `vis_salesvisitplans` | Entity set / collection name of the visit plan table. |
| `planStatusField` | No | `vis_status` | Choice column for plan status write-back. |
| `driveMinutesField` | No | `vis_new_totaldriveminutes` | Whole-number column for total optimized drive time. |
| `workDayStartField` | No | `vis_starttime` | Column that stores the work-day start. |
| `workDayEndField` | No | `vis_workdayend` | Column that stores the work-day end. |
| `isPriorityField` | No | `vis_new_ispriority` | Boolean column marking a priority visit. |
| `visitOrderField` | No | `vis_new_visitorder` | Whole-number column storing optimized visit order. |
| `invitationStatusField` | No | `vis_new_invitationstatus` | Choice column tracking invitation status. |
| `planLookupField` | No | `vis_new_salesvisitplanid` | Lookup column on appointment referencing the plan. |
| `planLookupNav` | No | `vis_new_salesvisitplanid_Appointment` | Relationship / navigation property for the lookup. |
| `lastVisitField` | No | `vis_lastvisitdate` | Last-visit-date column on account. |
| `geocodeCountrySet` | No | `DK,SE,NO,DE,NL,BE,FR,GB` | Comma-separated ISO country codes to bias geocoding. |
| `defaultMapCenter` | No | (northern Europe) | Map position for a plan with no geocoded visits: `lat,lon` or `lat,lon,zoom`, for example `55.68,12.57,11`. |

---

## Reuse model

The control is built as a reusable engine with the customer context externalized:

- **Core (this control).** Map rendering, route optimization, drive-time timeline, prospect search, and all read/write logic. Unchanged between installs.
- **Context (your data model and story).** Table, column, relationship, and choice names, supplied through the configuration properties above and the `SalesVisitPlannerReference` solution. Schema definition and sample data live in `installer/*.json`.

To reuse the control against a different schema, map each property to your own logical names. No source changes are required.

---

## Build from source

```
npm install
npm run build      # production build
npm start          # local test harness with sample data
```

Requires Node.js and the Power Platform CLI (`pac`) prerequisites for PCF.

---

## License

MIT. See [LICENSE](./LICENSE).
