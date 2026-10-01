<#
.SYNOPSIS
    Loads a sample day (accounts, contacts, visit plans, appointments) from a JSON file into Dataverse.

.DESCRIPTION
    Generic and re-runnable: accounts are matched by name, plans by name, appointments by subject
    within their plan. Existing records are updated, missing ones are created. Dates are relative
    (dayOffset, HH:mm, negative day counts for last-visit dates) so the same file produces a
    fresh day whenever you run it. The story lives in sample-data.json; swap that file for a
    different territory or industry.

    Every run also applies resetFields from the JSON, which clears what the control writes back
    (visit order, invitation status, total drive minutes). Re-run the script to replay a demo.

    Appointments get the account as a Required attendee, because that is how the control resolves
    the visit address, and the plan lookup, because that is how the control attaches visits to a
    plan. Contacts are set as the account's primary contact, because that is who the Invitations
    panel emails. The sample contacts use example.com addresses, which never deliver.

.PARAMETER EnvironmentUrl
    Dataverse environment URL, for example https://contoso.crm4.dynamics.com

.PARAMETER DataPath
    Path to the sample data JSON. Defaults to sample-data.json next to this script.

.PARAMETER SchemaPath
    Path to the schema definition, used for the plan table and lookup names. Defaults to
    reference-schema.json next to this script.

.PARAMETER AccessToken
    Optional bearer token. When omitted, the script asks the Azure CLI.

.EXAMPLE
    .\Import-SampleData.ps1 -EnvironmentUrl https://contoso.crm4.dynamics.com
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $EnvironmentUrl,
    [string] $DataPath = (Join-Path $PSScriptRoot 'sample-data.json'),
    [string] $SchemaPath = (Join-Path $PSScriptRoot 'reference-schema.json'),
    [string] $AccessToken
)

$ErrorActionPreference = 'Stop'
$EnvironmentUrl = $EnvironmentUrl.TrimEnd('/')
$api = "$EnvironmentUrl/api/data/v9.2"
$data = Get-Content -Raw -Path $DataPath | ConvertFrom-Json
$schema = Get-Content -Raw -Path $SchemaPath | ConvertFrom-Json

if (-not $AccessToken) {
    $AccessToken = az account get-access-token --resource $EnvironmentUrl --query accessToken -o tsv
    if (-not $AccessToken) { throw "No access token. Run 'az login' or pass -AccessToken." }
}
$headers = @{
    Authorization      = "Bearer $AccessToken"
    'OData-MaxVersion' = '4.0'
    'OData-Version'    = '4.0'
    Accept             = 'application/json'
}

function Invoke-Dv([string] $Method, [string] $Path, $Body) {
    $p = @{ Method = $Method; Uri = "$api/$Path"; Headers = $headers.Clone() }
    if ($null -ne $Body) {
        $p.ContentType = 'application/json; charset=utf-8'
        $p.Headers['Prefer'] = 'return=representation'
        $p.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 10 -Compress))
    }
    Invoke-RestMethod @p
}

function Find-Id([string] $Set, [string] $IdField, [string] $Filter) {
    $r = Invoke-Dv GET "$Set`?`$select=$IdField&`$filter=$Filter&`$top=1"
    if ($r.value.Count -gt 0) { return $r.value[0].$IdField }
    $null
}

function Save-Record([string] $Set, [string] $IdField, [string] $Filter, [hashtable] $Body, [string] $Label) {
    $id = Find-Id $Set $IdField $Filter
    if ($id) {
        Invoke-Dv PATCH "$Set($id)" $Body | Out-Null
        Write-Host "Updated $Label."
        return $id
    }
    $created = Invoke-Dv POST $Set $Body
    Write-Host "Created $Label."
    $created.$IdField
}

function Esc([string] $s) { $s.Replace("'", "''") }

$tz = [TimeZoneInfo]::FindSystemTimeZoneById($data.windowsTimeZone)
function To-Utc([int] $DayOffset, [string] $HhMm) {
    $local = [DateTime]::ParseExact(
        (Get-Date).Date.AddDays($DayOffset).ToString('yyyy-MM-dd') + ' ' + $HhMm,
        'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture)
    [TimeZoneInfo]::ConvertTimeToUtc($local, $tz).ToString("yyyy-MM-ddTHH:mm:ssZ")
}

# Names of the plan table and lookup come from the schema, not from this script.
$planTable = $schema.tables | Where-Object { $_.create } | Select-Object -First 1
$planSet = (Invoke-Dv GET "EntityDefinitions(LogicalName='$($planTable.logicalName)')?`$select=EntitySetName").EntitySetName
$planId = "$($planTable.logicalName)id"
$planName = $planTable.primaryName.schemaName.ToLowerInvariant()
$lookup = $schema.lookups | Where-Object { $_.referencedTable -eq $planTable.logicalName } | Select-Object -First 1
$planNav = $lookup.referencingNavigationProperty
$lookupFieldValue = "_$($lookup.lookupSchemaName.ToLowerInvariant())_value"

$accountIds = @{}
foreach ($a in $data.accounts) {
    $body = @{}
    foreach ($prop in $a.PSObject.Properties) {
        if ($prop.Name -in 'key', 'relativeDates') { continue }
        $body[$prop.Name] = $prop.Value
    }
    if ($a.relativeDates) {
        foreach ($d in $a.relativeDates.PSObject.Properties) { $body[$d.Name] = To-Utc ([int]$d.Value) '10:00' }
    }
    $accountIds[$a.key] = Save-Record 'accounts' 'accountid' "name eq '$(Esc $a.name)'" $body "account '$($a.name)'"
}

function Add-Fields([hashtable] $Body, $Fields) {
    if ($Fields) { foreach ($f in $Fields.PSObject.Properties) { $Body[$f.Name] = $f.Value } }
}

# Contacts become the account's primary contact, which is who the Invitations panel emails.
foreach ($c in $data.contacts) {
    $accountGuid = $accountIds[$c.account]
    $body = @{ 'parentcustomerid_account@odata.bind' = "/accounts($accountGuid)" }
    foreach ($prop in $c.PSObject.Properties) {
        if ($prop.Name -eq 'account') { continue }
        $body[$prop.Name] = $prop.Value
    }
    $contactId = Save-Record 'contacts' 'contactid' "emailaddress1 eq '$(Esc $c.emailaddress1)'" $body "contact '$($c.firstname) $($c.lastname)'"
    Invoke-Dv PATCH "accounts($accountGuid)" @{ 'primarycontactid@odata.bind' = "/contacts($contactId)" } | Out-Null
}

$planIds = @{}
foreach ($p in $data.plans) {
    $name = $p.name.Replace('{date}', (Get-Date).Date.AddDays([int]$p.dayOffset).ToString('yyyy-MM-dd'))
    $body = @{ $planName = $name }
    Add-Fields $body $data.resetFields.plan
    if ($p.times) { foreach ($t in $p.times.PSObject.Properties) { $body[$t.Name] = To-Utc ([int]$p.dayOffset) $t.Value } }
    Add-Fields $body $p.fields
    $planIds[$p.key] = Save-Record $planSet $planId "$planName eq '$(Esc $name)'" $body "plan '$name'"
}

foreach ($ap in $data.appointments) {
    $plan = $data.plans | Where-Object { $_.key -eq $ap.plan }
    $startUtc = To-Utc ([int]$plan.dayOffset) $ap.start
    $endUtc = ([DateTime]::Parse($startUtc).ToUniversalTime().AddMinutes([int]$ap.durationMinutes)).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $planGuid = $planIds[$ap.plan]
    $accountGuid = $accountIds[$ap.account]
    $body = @{
        subject               = $ap.subject
        scheduledstart        = $startUtc
        scheduledend          = $endUtc
        "$planNav@odata.bind" = "/$planSet($planGuid)"
    }
    Add-Fields $body $data.resetFields.appointment
    Add-Fields $body $ap.fields
    $filter = "subject eq '$(Esc $ap.subject)' and $lookupFieldValue eq $planGuid"
    $id = Find-Id 'appointments' 'activityid' $filter
    if ($id) {
        Invoke-Dv PATCH "appointments($id)" $body | Out-Null
        Write-Host "Updated appointment '$($ap.subject)'."
    } else {
        $body['appointment_activity_parties'] = @(@{
            'partyid_account@odata.bind' = "/accounts($accountGuid)"
            participationtypemask        = 5
        })
        Invoke-Dv POST 'appointments' $body | Out-Null
        Write-Host "Created appointment '$($ap.subject)'."
    }
}

Write-Host "Sample data loaded. Open the plan record to see the Planner control."
