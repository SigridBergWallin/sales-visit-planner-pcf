# Setup guide

This guide installs the **Sales Visit Planner** control in a Power Platform environment, loads a
sample day, and walks a smoke test. It was last run end to end on a clean environment with
control 1.6.9 and reference solution 1.0.1.0.

Control identity: `vis_FieldSales.SalesVisitPlanner`.

There are three ways in. Pick one:

| Path | Use it when | Sections |
| --- | --- | --- |
| **A. Import both solutions** | You want a working planner in 15 minutes. | 1, 2, 3, 6 to 8 |
| **B. Script the schema** | You want the data model in your own unmanaged solution, or a different prefix. | 1, 4, 5, 6 to 8 |
| **C. Map onto your own tables** | You already have visit-plan data. | 1, 5, [Appendix A](#appendix-a-using-your-own-schema) |

---

## 1. Prerequisites

- A Power Platform environment with a Dataverse database. A Developer or Sandbox environment is ideal for a first test.
- **System Administrator** or **System Customizer** in that environment.
- An **Azure Maps** account and its subscription key (Azure portal, your Maps account, **Authentication**, **Shared Key**). You supply the key; none ships with the control.
- If your Azure Maps account has **CORS** rules, add your environment URL (for example `https://contoso.crm4.dynamics.com`) to the allowed origins. Without it the browser blocks every map, geocode, and route call, and the console shows CORS errors.
- For paths B and C, and for the sample data: **PowerShell 5.1 or later** and the **Azure CLI** (`az login --allow-no-subscriptions`).

---

## 2. Import the solutions (path A)

Download all four zips from [Releases](https://github.com/SigridBergWallin/sales-visit-planner-pcf/releases/latest). Use the managed pair for test and production, the unmanaged pair for development.

Import them in this order. The order matters: the reference solution's form hosts the control, so
the control has to be there first.

1. `SalesVisitPlanner_managed.zip`, the control.
2. `SalesVisitPlannerReference_managed.zip`, the data model, form, and app.

Both use the `vis` publisher prefix. In the maker portal: **Solutions**, **Import solution**, pick
the file, **Next**, **Import**. With the CLI:

```
pac auth create --environment "https://<env>.crm4.dynamics.com"
pac solution import --path SalesVisitPlanner_managed.zip --publish-changes
pac solution import --path SalesVisitPlannerReference_managed.zip --publish-changes
```

The reference solution gives you:

- The **Sales Visit Plan** table, with its main form already hosting the control.
- Extension columns on **Appointment** and **Account**, the plan-to-appointment lookup, and both
  choice columns with the option values the control expects.
- A model-driven app, **Sales Visit Planner**, with Sales Visit Plans, Appointments, and Accounts in the navigation.

See [reference-solution/README.md](../reference-solution/README.md) for the full component list.

---

## 3. Add your Azure Maps key to the form (path A)

The shipped form leaves the key blank. Until you set it, the planner shows *Azure Maps key is not
configured* and renders the visit list without a map.

1. make.powerapps.com, **Tables**, **Sales Visit Plan**, **Forms**, open the **Information** main form.
2. Select the **Planner** field, then the **Sales Visit Planner** component in the properties pane.
3. Paste your key into **Azure Maps Key**. Optionally set **Default Map Center** (see [section 5](#5-control-properties)).
4. **Save and publish**.

This edit lives in your environment's unmanaged layer on top of the managed form. It survives
upgrades of the reference solution.

Then share the app: open **Apps**, **Sales Visit Planner**, **Share**, and add the security roles
that should see it. System Administrators see it without sharing.

Continue at [section 6](#6-load-sample-data).

---

## 4. Script the schema (path B)

`installer/Install-Schema.ps1` builds the data model from `installer/reference-schema.json`, inside
an unmanaged solution. It is idempotent: it creates the publisher, solution, table, columns,
lookup, and choice options, skips anything that exists, and publishes.

```
az login --allow-no-subscriptions
cd installer
.\Install-Schema.ps1 -EnvironmentUrl https://<env>.crm4.dynamics.com
```

To use a different prefix or names, edit `reference-schema.json` (not the script), then set the
matching control properties from [Appendix A](#appendix-a-using-your-own-schema).

The script creates schema only. Then:

1. Import `SalesVisitPlanner_managed.zip` (the control).
2. Put the control on the Sales Visit Plan main form:
   1. Add the **Planner** column (`vis_plannercanvas`) to a full-width, one-column section.
   2. Select it, **Components**, **Get more components**, pick **SalesVisitPlanner**, add it, and enable it for Web, Phone, and Tablet.
   3. Set **Azure Maps Key**. Leave the schema properties blank if you kept the reference names.
   4. Hide the field label, then **Save and publish**.
3. Add Sales Visit Plan, Appointment, and Account to a model-driven app.

If you prefer to click through the maker portal instead of running the script, create exactly what
`reference-schema.json` lists. Two traps:

- **Choice values.** New publishers default to a choice prefix that produces values like
  `801010000`. The control needs `100000000` and up. Either set the publisher's **Choice value
  prefix** to `10000`, or edit each option's value by hand. Values are in [section 9](#9-choice-values).
- **Lookup navigation property.** The control binds appointments to plans through the lookup's
  navigation property, default `vis_new_salesvisitplanid_Appointment`. Check yours in
  `https://<env>.crm4.dynamics.com/api/data/v9.2/$metadata` under `EntityType Name="appointment"`,
  and set **Plan Lookup Navigation Property** if it differs.

---

## 5. Control properties

Every schema property defaults to the reference name, so a reference install needs only the key.

| Property | Default | Notes |
| --- | --- | --- |
| **Azure Maps Key** (`azureMapsKey`) | blank | Required for the map. |
| **Default Map Center** (`defaultMapCenter`) | wide northern Europe view | `lat,lon` or `lat,lon,zoom`, for example `55.68,12.57,11`. Shown when a plan has no geocoded visits. |
| **Geocode Country Set** (`geocodeCountrySet`) | `DK,SE,NO,DE,NL,BE,FR,GB` | ISO codes that bias address lookups. |

The twelve schema properties are listed in [Appendix A](#appendix-a-using-your-own-schema).

---

## 6. Load sample data

`installer/Import-SampleData.ps1` loads a fictional day in Copenhagen from
`installer/sample-data.json`: eight accounts with addresses and coordinates, four contacts, one
plan, and four appointments.

```
cd installer
.\Import-SampleData.ps1 -EnvironmentUrl https://<env>.crm4.dynamics.com
```

It is safe to re-run. Accounts match by name, the plan by name, and appointments by subject within
the plan. Each run also clears what the control writes back (visit order, invitation status, total
drive minutes), so you can replay a demo from the start. Dates are relative, so the plan is always
for the day you run the script.

To tell a different story, copy `sample-data.json`, change the accounts and visits, and pass
`-DataPath`. The script stays the same.

### Building test data by hand

What the control needs from each record:

- **Account**: a street, city, postal code, and a country in the geocode country set. Territory
  Insights also uses the stored `address1_latitude` and `address1_longitude`, and ranks by
  **Last Visit Date** (`vis_lastvisitdate`). Nothing in the control writes that date; your own
  process does.
- **Primary contact** with an email address on each account you want to invite. Without one, the
  Invitations panel flags the row as *No contact* and offers to add one.
- **Sales Visit Plan**: Work Day Start and Work Day End on the plan day, Plan Status **Active**.
  The date part of Work Day Start sets the plan day; the time parts set working hours (08:00 to
  17:00 when blank).
- **Appointment**: scheduled start and end on the plan day, the account as a **Required** attendee
  (this is how the control finds the address), and the **Sales Visit Plan** lookup set. Visits
  attach to a plan by that lookup, not by date.

Set your **personal time zone** (Settings, Personalization Settings) to the plan's region. The
timeline shows times in the user's time zone, so a mismatch shifts every visit.

---

## 7. Smoke test (10 minutes)

Open **Sales Visit Planner**, **Sales Visit Plans**, and the sample plan.

1. **Map and timeline.** Four numbered pins, a blue route, and a timeline with drive times between visits.
2. **Optimize.** Shows current versus optimized order and drive time. **Apply** saves the new times, `vis_new_visitorder` on each visit, and `vis_new_totaldriveminutes` on the plan.
3. **Invitations.** Lists each visit's contact. **Send** creates email activities and sets each visit to *Invitation Sent*.
4. **Territory insights.** Ranks nearby accounts by last visit and draws them on the map. **Add to plan** schedules a visit after the last one.
5. **Find prospects.** Searches Azure Maps points of interest near the route and adds one as a lead and a visit.

Edge cases worth a minute each:

| Case | Expected |
| --- | --- |
| Key missing | *Azure Maps key is not configured*, list only, no crash. |
| Visit with no address | *Not on map* badge on the card; the other visits still route. |
| Plan with no visits | Empty state with guidance and an **Open territory insights** button; map at the default center. |
| Priority visit | Flag one appointment as Priority Visit: an URGENT badge appears, and **Move to Top & Recalculate** reschedules the open visits from the earliest open slot. |
| Account with no contact | Row flagged *No contact* in Invitations, with a button to add one. |

---

## 8. Things that surprise people

- **Sending invitations completes the plan.** After Send, Plan Status changes to Completed. The
  form shows the old value until you refresh.
- **Emails stay Pending Send** unless the user has a mailbox with server-side synchronization.
  The control creates the email activities either way.
- **The email signature comes from the user record.** Fill in full name, job title, email, and
  phone on the sending user.
- **After upgrading the control, clear site data.** Browsers cache the old bundle. In Edge or
  Chrome: the lock icon in the address bar, **Site permissions** or **Cookies and site data**,
  clear the data for the Dynamics URL, then reload. A normal refresh is not always enough.
- **Drive times differ slightly between views.** The header uses the route service; the Optimize
  dialog uses the route matrix. Expect a few minutes of difference.

---

## 9. Choice values

These option values are compiled into the control. The reference solution and the schema script
create them; if you build the columns by hand, match the values.

**Invitation Status** (`vis_new_invitationstatus`)

| Label | Value |
| --- | --- |
| Not Sent | 100000000 |
| Invitation Sent | 100000001 |
| Accepted | 100000002 |
| Declined | 100000003 |

The planner shows *Invitation Sent* as an **Invited** pill.

**Plan Status** (`vis_status`)

| Label | Value | Written by the control |
| --- | --- | --- |
| Draft | 100000000 | |
| Active | 100000001 | yes |
| Completed | 100000002 | yes |
| Cancelled | 100000003 | |
| In Progress | 100000004 | |

---

## 10. Rollback

**Managed install (path A).** Delete the solutions in reverse order: **Sales Visit Planner
Reference** first, then **Sales Visit Planner**. Deleting the managed reference solution removes
the table, its data, the extension columns on Account and Appointment, the form, and the app.
Export any plan data you want to keep first. Your unmanaged form edit (the Maps key) goes with it.

**Scripted install (path B).** Deleting an unmanaged solution does not delete its components.
Remove the control from the form, delete the lookup relationship, the Sales Visit Plan table, and
the four extension columns, then delete the solution and the control solution.

No other environment is affected.

---

## Appendix A: using your own schema

Point the control at your tables by setting these properties on the form. Blank means the default.

| Control property | Reference default |
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

Your choice columns still need the values in [section 9](#9-choice-values), whatever their names.
