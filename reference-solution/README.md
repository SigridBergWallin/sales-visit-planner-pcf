# Sales Visit Planner reference solution

A schema-only Dataverse solution that provisions the data model the control expects. Import it and
the control works with no configuration beyond `azureMapsKey`.

| File | Use |
| --- | --- |
| `SalesVisitPlannerReference_managed.zip` | Test and production environments. |
| `SalesVisitPlannerReference.zip` | Development environments, or if you want to edit the schema. |

Version 1.0.0.0, publisher prefix `vis`, publisher `FieldSalesTools`.

## What it contains

Fourteen components, and nothing else:

**Sales Visit Plan** (`vis_salesvisitplan`), a new custom table

| Column | Type |
| --- | --- |
| `vis_name` | Text, primary name |
| `vis_starttime` | Date and time, work day start |
| `vis_workdayend` | Date and time, work day end |
| `vis_status` | Choice, plan status |
| `vis_new_totaldriveminutes` | Whole number, cached drive time |

**Appointment**, the standard activity table, extended

| Column | Type |
| --- | --- |
| `vis_new_ispriority` | Yes/No |
| `vis_new_visitorder` | Whole number |
| `vis_new_invitationstatus` | Choice |
| `vis_new_salesvisitplanid` | Lookup to Sales Visit Plan |

**Account**, the standard table, extended

| Column | Type |
| --- | --- |
| `vis_lastvisitdate` | Date and time |

Plus the `vis_salesvisitplan_appointment` relationship.

Appointment and Account are included as shells, so importing this solution adds the columns above
without taking ownership of the standard tables.

## What it deliberately does not contain

- **No form.** The control has to sit on a form, but shipping one here would bind the schema
  solution to the control solution and make neither installable on its own. Add the control to your
  own form instead, as described in [SETUP.md](../docs/SETUP.md).
- **No app, no views, no data.** This is a schema contract, not a demo.
- **No columns the control does not read.** The control's manifest exposes 17 configuration
  properties; the schema properties among them map exactly onto the columns above.

## Using your own schema instead

You do not have to import this. Every schema name the control uses is a configuration property with
a default, so you can point the control at tables and columns you already own by overriding those
properties on the form. See the configuration table in the [main README](../README.md).

The one thing you cannot rename is the option values on the two choice columns. Those are compiled
into the control. Match them exactly, or import this solution to get them right.

## Rebuilding this solution

It is exported from a Dataverse environment rather than authored by hand:

```
pac solution export --path reference-solution --name SalesVisitPlannerReference --managed false --overwrite
pac solution export --path reference-solution --name SalesVisitPlannerReference --managed true  --overwrite
```
