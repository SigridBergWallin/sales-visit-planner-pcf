# Fresh environment setup and test guide

This guide provisions the data model the **Sales Visit Planner** control expects, deploys the
control, and walks a smoke test in a clean Power Platform environment. Every schema name below
is the reference default the control ships with, so if you match these names the control needs
only an Azure Maps key to run. To use your own names, see [Appendix A](#appendix-a--using-a-different-publisher-prefix).

Control identity: `FieldSales.SalesVisitPlanner`.

---

## 1. Prerequisites

- A Power Platform environment with a Dataverse database (a Developer or Trial environment is ideal for a throwaway test).
- **System Administrator** or **System Customizer** role in that environment.
- An **Azure Maps** account and a subscription key from the Azure portal (Azure Maps account, Authentication, Shared Key). The installer supplies this key. No key ships with the control.
- **Power Platform CLI** (`pac`) and **Node.js** installed. Node is also needed to build the control.
- This repository, cloned and built (`npm install` then `npm run build`).

Model-driven forms run code components by default. The environment setting *Power Apps component
framework for canvas apps* is canvas-only and is not required here.

---

## 2. Fastest path: import the reference solution

Sections 3 and 4 below build the data model by hand. You only need them if you want to understand
the schema, or you are mapping the control onto tables you already own.

To skip straight to a working environment:

1. Download `SalesVisitPlannerReference_managed.zip` from [Releases](https://github.com/SigridBergWallin/sales-visit-planner-pcf/releases/latest).
2. Import it. It creates the Sales Visit Plan table, the Account and Appointment extension columns,
   the plan-to-appointment relationship, and both choice columns with the exact option values the
   control expects, all under the `vis` prefix.
3. Continue from [section 5, Deploy the control](#5-deploy-the-control).

The reference solution ships no form, so you still add the control to the form yourself in section 6.
That keeps the schema and the control independent of each other.

---

## 2a. Building it by hand: match the reference names

Create everything under a publisher whose **prefix is `vis`** and give each table, column, and
choice the exact default name shown below. The control then needs only `boundField` and
`azureMapsKey`; every schema property falls back to its default. A different prefix means setting
all schema properties by hand, so match the reference for the first test.

---

## 3. Create a solution and publisher

1. Go to make.powerapps.com and select the target environment.
2. **Solutions**, **New solution**, **New publisher**: name it (for example `Sales Visit Planner`), set the **prefix** to `vis`.
3. Create an unmanaged solution, for example `Sales Visit Planner Test`, using that publisher. Build all objects below inside it.

---

## 4. Create the data model

When you type a column name, the maker shows the `vis_` prefix and you type the rest. To produce
`vis_new_ispriority`, type `new_ispriority` in the name box under the `vis` publisher.

### 4.1 Sales Visit Plan table (new custom table)

Create a table with logical name **`vis_salesvisitplan`** (entity set auto-pluralizes to
`vis_salesvisitplans`). Add these columns:

| Display name | Type the name as | Logical name | Data type |
| --- | --- | --- | --- |
| Work Day Start | `starttime` | `vis_starttime` | Date and Time |
| Work Day End | `workdayend` | `vis_workdayend` | Date and Time |
| Plan Status | `status` | `vis_status` | Choice (values below) |
| Total Drive Minutes | `new_totaldriveminutes` | `vis_new_totaldriveminutes` | Whole Number |
| Planner | `plannercanvas` | `vis_plannercanvas` | Single line of text |

Notes:
- **Work Day Start** and **Work Day End** are Date and Time. The **date** part of Work Day Start
  sets the plan day shown in the header and timeline. The **time** parts set working hours
  (defaults 08:00 to 17:00 when blank).
- **Planner** is a placeholder text column that hosts the control on the form. The control renders
  in its place and reads the current record id from form context.

**Plan Status** choice values (match exactly):

| Label | Value |
| --- | --- |
| Active | 100000001 |
| Completed | 100000002 |

You may add other labels (Draft, Cancelled, and so on), but the control only writes Active and Completed.

### 4.2 Account table (extend the standard table)

Add one column to the standard **Account** table:

| Display name | Type the name as | Logical name | Data type |
| --- | --- | --- | --- |
| Last Visit Date | `lastvisitdate` | `vis_lastvisitdate` | Date and Time |

Used by Territory Insights to rank nearby accounts by recency.

### 4.3 Appointment table (extend the standard activity)

Add these columns to the standard **Appointment** activity:

| Display name | Type the name as | Logical name | Data type |
| --- | --- | --- | --- |
| Priority Visit | `new_ispriority` | `vis_new_ispriority` | Yes/No |
| Visit Order | `new_visitorder` | `vis_new_visitorder` | Whole Number |
| Invitation Status | `new_invitationstatus` | `vis_new_invitationstatus` | Choice (values below) |
| Sales Visit Plan | `new_salesvisitplanid` | `vis_new_salesvisitplanid` | Lookup to **Sales Visit Plan** |

**Invitation Status** choice values (match exactly):

| Label | Value |
| --- | --- |
| Not sent | 100000000 |
| Invited | 100000001 |
| Accepted | 100000002 |
| Declined | 100000003 |

**Lookup navigation property.** The lookup creates a relationship. The control writes the
appointment to plan link with `{planLookupNav}@odata.bind`, defaulting to
`vis_new_salesvisitplanid_Appointment`. After creating the lookup, confirm the actual
single-valued navigation property name:

1. Open `https://<env>.crm.dynamics.com/api/data/v9.2/$metadata`.
2. Find `EntityType Name="appointment"`.
3. Locate the `NavigationProperty` whose `Type` points to `vis_salesvisitplan`. Its `Name` is the value.

If that name is not `vis_new_salesvisitplanid_Appointment`, set the **Plan Lookup Navigation
Property** (`planLookupNav`) control property to the actual name in step 6.

Publish all customizations.

---

## 5. Deploy the control

### Option A: quick push (recommended for a test)

```
pac auth create --environment "https://<env>.crm.dynamics.com"
npm install
npm run build
pac pcf push --publisher-prefix vis
```

`pac pcf push` packages the control into a `PowerAppsTools_vis` solution and imports it into the
authenticated environment.

### Option B: import the released solution

Download `SalesVisitPlanner_managed.zip` from [Releases](https://github.com/SigridBergWallin/sales-visit-planner-pcf/releases/latest) and import it through
**Solutions**, **Import** in the maker portal. This is the normal path for anything other than a
throwaway test.

### Option C: build the solution zip from source

The repo already contains the solution project, so there is nothing to scaffold:

```
cd SalesVisitPlannerSolution
dotnet build -c Release
```

That produces both flavours under `bin\Release`:

- `SalesVisitPlannerSolution.zip` (unmanaged, for a dev environment)
- `SalesVisitPlannerSolution_managed.zip` (managed, for test and production)

Import whichever suits the target environment.

---

## 6. Put the control on the form

1. Open the **Sales Visit Plan** table, **Forms**, edit the main form.
2. Add the **Planner** column (`vis_plannercanvas`) to a section that can grow (a full-width, one-column section reads best).
3. Select the field, **Components**, **Get more components**, pick **SalesVisitPlanner**, add it, and enable it for Web, Phone, and Tablet.
4. Set control properties:
   - **Bound Field**: the Planner column (`vis_plannercanvas`).
   - **Azure Maps Key**: your subscription key.
   - Leave every schema property blank to use the reference defaults. Set **Plan Lookup Navigation Property** only if step 4.3 showed a different name.
5. Save and publish.
6. Add **Sales Visit Plan**, **Account**, and **Appointment** to a model-driven app (or reuse an existing one) so you can open records.

---

## 7. Create test data

1. **Account** with a full address (street, city, postal code, and a country in DK, SE, NO, DE, NL, BE, FR, or GB, for example Copenhagen). Set **Owner** to yourself. Optionally set **Last Visit Date** to exercise Territory Insights.
2. **Sales Visit Plan** record: **Work Day Start** = today 08:00, **Work Day End** = today 17:00, **Plan Status** = Active.
3. **Two or three Appointments**:
   - Subject and a **Scheduled Start / End** today within working hours.
   - Add the account as a **Required** attendee. This is how the control resolves the address. (Alternatively set **Regarding** to an opportunity whose parent account has an address.)
   - Set **Sales Visit Plan** (the lookup) to the plan record from step 2.
   - Flag one as **Priority Visit** to see priority handling.
4. Open the **Sales Visit Plan** record. The Planner control renders in place of the Planner field.

Appointments attach to a plan by the lookup, not by date, so the lookup must be set. Scheduled
times drive ordering and the timeline.

---

## 8. Smoke test (5 to 10 minutes)

- The list panel shows the appointments; the map shows a pin per resolvable address.
- Run **route optimization**: visit order and per-leg plus total drive time populate (`vis_new_visitorder` on each appointment, `vis_new_totaldriveminutes` on the plan).
- **Send invitations**: invitation pills update, and plan status advances (Active, then Completed) as designed.
- **Territory Insights**: nearby accounts list, ranked by last visit date.
- **Prospect search**: find and add an unplanned account or lead to the day.

---

## 9. Edge cases to verify

- **Missing Azure Maps key**: clear message, no crash.
- **Appointment with no resolvable address**: flagged, the rest still route.
- **Empty plan** (no linked appointments): graceful empty state.
- **Limited-permission user**: no data beyond their rights, graceful handling.
- **Blank config values**: fall back to the reference defaults.

---

## 10. Rollback

Everything lives in one unmanaged solution in an isolated environment. To remove it, delete the
`Sales Visit Planner Test` solution and the `PowerAppsTools_vis` control solution, then delete the
custom **Sales Visit Plan** table. The standard Account and Appointment tables keep the added
columns until you remove them. No other environment is affected.

---

## Appendix A: using a different publisher prefix

If you cannot use the `vis` prefix, create the tables, columns, relationship, and choices under
your own prefix, then set every schema property on the control to your logical names:

| Control property | Set to your equivalent of |
| --- | --- |
| `planTable` | `vis_salesvisitplan` |
| `planCollection` | `vis_salesvisitplans` |
| `workDayStartField` | `vis_starttime` |
| `workDayEndField` | `vis_workdayend` |
| `planStatusField` | `vis_status` |
| `driveMinutesField` | `vis_new_totaldriveminutes` |
| `isPriorityField` | `vis_new_ispriority` |
| `visitOrderField` | `vis_new_visitorder` |
| `invitationStatusField` | `vis_new_invitationstatus` |
| `planLookupField` | `vis_new_salesvisitplanid` |
| `planLookupNav` | `vis_new_salesvisitplanid_Appointment` |
| `lastVisitField` | `vis_lastvisitdate` |
| `geocodeCountrySet` | `DK,SE,NO,DE,NL,BE,FR,GB` |

The invitation and plan status **values** (100000000 to 100000003, and 100000001 or 100000002)
are compiled into the control. Your choice columns must use those exact values regardless of prefix.
