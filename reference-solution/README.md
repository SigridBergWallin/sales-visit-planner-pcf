# Sales Visit Planner reference solution

A ready-to-run package: the data model the control expects, a main form that already hosts the
control, and a model-driven app. Import it after the control and you have a working planner once
you add your Azure Maps key.

| File | Use |
| --- | --- |
| `SalesVisitPlannerReference_managed.zip` | Test and production environments. |
| `SalesVisitPlannerReference.zip` | Development environments, or if you want to change the model. |

Version 1.0.1.0, publisher `FieldSalesTools`, prefix `vis`.

## Install

1. Import the control solution, `SalesVisitPlanner_managed.zip` (1.6.9 or later).
2. Import this solution.
3. Open the Sales Visit Plan **Information** form, select the Planner component, paste your key into
   **Azure Maps Key**, then save and publish.

The import fails with a missing-dependency error if the control is not there yet. That is expected:
the form references it. Full steps, sample data, and a smoke test are in
[docs/SETUP.md](../docs/SETUP.md).

## What it contains

**Sales Visit Plan** (`vis_salesvisitplan`), a new user-owned table

| Column | Type | Purpose |
| --- | --- | --- |
| `vis_name` | Text, primary name | Plan name |
| `vis_starttime` | Date and time | Plan day and work day start |
| `vis_workdayend` | Date and time | Work day end |
| `vis_status` | Choice | Draft, Active, Completed, Cancelled, In Progress |
| `vis_new_totaldriveminutes` | Whole number | Optimized drive time, written by the control |
| `vis_plannercanvas` | Text | Placeholder the control renders in. Holds no data. |

Plus its **Information** main form with the control bound to `vis_plannercanvas`.

**Appointment**, extended

| Column | Type |
| --- | --- |
| `vis_new_ispriority` | Yes/No |
| `vis_new_visitorder` | Whole number |
| `vis_new_invitationstatus` | Choice: Not Sent, Invitation Sent, Accepted, Declined |
| `vis_new_salesvisitplanid` | Lookup to Sales Visit Plan (relationship `vis_salesvisitplan_appointment`) |

**Account**, extended

| Column | Type |
| --- | --- |
| `vis_lastvisitdate` | Date and time, read by Territory Insights |

**Sales Visit Planner** app (`vis_SalesVisitPlanner`) with Sales Visit Plans, Appointments, and Accounts.

Appointment and Account are included as shells: the import adds the columns above without taking
ownership of the standard tables or their forms. Choice option values are in
[SETUP.md section 9](../docs/SETUP.md#9-choice-values).

## What it does not contain

- **No Azure Maps key.** The form ships with the key blank. Add yours as an unmanaged change on top.
- **No data.** Load the fictional sample day with `installer/Import-SampleData.ps1`.
- **No security role.** Share the app with your own roles.

## Using your own schema instead

Skip this solution, put the control on your own form, and point it at your tables through the
configuration properties. See [SETUP.md Appendix A](../docs/SETUP.md#appendix-a-using-your-own-schema).
Or generate the model into your own unmanaged solution with `installer/Install-Schema.ps1`, which
reads `installer/reference-schema.json`.

## Rebuilding this solution

Exported from a development environment, then the Azure Maps key is cleared from the form XML
before release:

```
pac solution export --path SalesVisitPlannerReference.zip --name SalesVisitPlannerReference --managed false --overwrite
pac solution export --path SalesVisitPlannerReference_managed.zip --name SalesVisitPlannerReference --managed true --overwrite
```

Before committing, empty every `<azureMapsKey>` element in `customizations.xml` inside both zips,
and search the zips for your key to confirm it is gone.
