# Sales Visit Planner (PCF)

A model-driven Power Apps code component that turns a day's appointments into an optimized field-sales route. It shows today's visits in a split panel: a scheduled list on the left and an interactive Azure Maps view on the right, with drive-time estimates, route optimization, a visit-order timeline, invitation tracking, and a Territory Insights view of nearby accounts.

Every table, column, relationship, and choice value the control touches is exposed as a manifest configuration property. The defaults match the reference data model, so the control works out of the box against that schema and can be pointed at a different schema without changing code.

> Control identity: `FieldSales.SalesVisitPlanner`

---

## Features

- Split-panel layout: scheduled appointment list beside a live Azure Maps map
- Route optimization with per-leg and total drive-time roll-up
- Visit-order timeline with priority flags
- Invitation status tracking (not sent, invited, accepted, declined)
- Territory Insights: nearby accounts ranked by last-visit date
- Prospect search to add unplanned accounts and leads to the day
- Geocoding biased to a configurable set of countries

---

## Screenshots

Add images under `images/` and reference them here before submitting to a gallery.

| Visit plan and map | Territory insights |
| --- | --- |
| `images/visit-plan.png` | `images/territory-insights.png` |

---

## Prerequisites

1. **Azure Maps account.** Create one in the Azure portal and copy a subscription key. The installer supplies their own key through the `azureMapsKey` property. No key ships with the control.
2. **Web API enabled.** The control uses the Dataverse Web API (declared as a required feature in the manifest).
3. **Data model.** Provision the tables, columns, relationship, and choice values described below (or install the companion reference solution).

The control renders on the **Sales Visit Plan** main form, bound to a text column and reading the current record id from form context.

---

## Data model

The control reads and writes the following schema. Names shown are the reference defaults; each is overridable through the matching configuration property (see the next section).

### Sales Visit Plan table (custom)

| Purpose | Default logical name | Type |
| --- | --- | --- |
| The visit plan table | `vis_salesvisitplan` | Custom table |
| Entity set / collection (for OData bind) | `vis_salesvisitplans` | (collection name) |
| Work-day start | `vis_starttime` | Time of day |
| Work-day end | `vis_workdayend` | Time of day |
| Plan status | `vis_status` | Choice |
| Optimized total drive minutes | `vis_new_totaldriveminutes` | Whole number |

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

The invitation and plan status option values are compiled into the control. If you create your own choice columns, use these exact values, or install the companion reference solution, which provisions them.

**Invitation status**

| Label | Value |
| --- | --- |
| Not sent | 100000000 |
| Invited | 100000001 |
| Accepted | 100000002 |
| Declined | 100000003 |

**Plan status**

| Label | Value |
| --- | --- |
| Active | 100000001 |
| Completed | 100000002 |

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

---

## Reuse model

The control is built as a reusable engine with the customer context externalized:

- **Core (this control).** Map rendering, route optimization, drive-time timeline, prospect search, and all read/write logic. Unchanged between installs.
- **Context (your data model).** Table, column, relationship, and choice names, supplied through the configuration properties above and the companion reference solution.

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
