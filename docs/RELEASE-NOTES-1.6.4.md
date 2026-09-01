# v1.6.4

First public release. The version number carries over from internal development, so there is no
earlier public version to compare against.

## What this is

A model-driven Power Apps code component that turns a day's appointments into an optimized
field-sales route. A scheduled list on the left, an interactive Azure Maps view on the right,
drive-time estimates between stops, a visit-order timeline, invitation tracking, and a Territory
Insights panel that ranks nearby accounts by how long it has been since anyone visited them.

Every table, column, relationship, and choice value the control touches is a manifest configuration
property. Seventeen in total. The defaults match the reference data model, so the control runs
untouched against that schema and points at a different schema without a code change.

## Assets

| File | Import into |
| --- | --- |
| `SalesVisitPlannerReference_managed.zip` | Test and production. Provisions the data model. |
| `SalesVisitPlannerReference.zip` | Development, or if you want to edit the schema. |
| `SalesVisitPlanner_managed.zip` | Test and production. The control. |
| `SalesVisitPlanner.zip` | Development. |

Import the reference solution first, then the control. Skip the reference solution if you are
mapping the control onto tables you already own.

Both solutions use the `vis` publisher prefix, so a default install needs no property overrides
beyond `azureMapsKey`.

## Requirements

- A model-driven app. The control reads model-driven form context and calls the Dataverse Web API,
  so canvas apps and Power Pages are not supported.
- An Azure Maps subscription key, supplied through the `azureMapsKey` property. No key ships with
  the control.

## Setting it up

[docs/SETUP.md](../blob/main/docs/SETUP.md) walks a fresh environment end to end, including the
smoke test and the edge cases worth checking.

The reference solution ships no form. Keeping the schema and the control in separate solutions with
no binding between them means neither depends on the other, and your form stays yours. You add the
control to the form yourself.

## Known limits

- Choice option values are compiled into the control. If you build the schema by hand rather than
  importing the reference solution, the invitation status and plan status values have to match
  exactly. Both tables are in the README.
- `vis_lastvisitdate` on Account has to be populated by your own process. Nothing in the control
  writes it; Territory Insights reads it and degrades quietly when it is absent.
