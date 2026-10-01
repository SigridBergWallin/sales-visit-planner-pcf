<#
.SYNOPSIS
    Creates a Dataverse data model from a JSON definition, inside an unmanaged solution.

.DESCRIPTION
    Generic and idempotent: creates the publisher, solution, custom tables, columns on new or
    existing tables, and one-to-many lookups described in the schema file, skipping anything that
    already exists. Then publishes. Nothing about a specific data model is hardcoded here; the
    Sales Visit Planner reference model lives in reference-schema.json.

    Run it against a development environment, then export the solution as managed for test and
    production (see docs/SETUP.md).

.PARAMETER EnvironmentUrl
    Dataverse environment URL, for example https://contoso.crm4.dynamics.com

.PARAMETER SchemaPath
    Path to the JSON schema definition. Defaults to reference-schema.json next to this script.

.PARAMETER AccessToken
    Optional bearer token for the environment. When omitted, the script asks the Azure CLI
    (az account get-access-token), so run az login first.

.EXAMPLE
    az login --allow-no-subscriptions
    .\Install-Schema.ps1 -EnvironmentUrl https://contoso.crm4.dynamics.com
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $EnvironmentUrl,
    [string] $SchemaPath = (Join-Path $PSScriptRoot 'reference-schema.json'),
    [string] $AccessToken
)

$ErrorActionPreference = 'Stop'
$EnvironmentUrl = $EnvironmentUrl.TrimEnd('/')
$api = "$EnvironmentUrl/api/data/v9.2"
$schema = Get-Content -Raw -Path $SchemaPath | ConvertFrom-Json
$lang = [int]$schema.language

if (-not $AccessToken) {
    $AccessToken = az account get-access-token --resource $EnvironmentUrl --query accessToken -o tsv
    if (-not $AccessToken) { throw "No access token. Run 'az login' or pass -AccessToken." }
}

$baseHeaders = @{
    Authorization      = "Bearer $AccessToken"
    'OData-MaxVersion' = '4.0'
    'OData-Version'    = '4.0'
    Accept             = 'application/json'
}

function Invoke-Dv {
    param([string] $Method, [string] $Path, $Body, [switch] $InSolution)
    $h = $baseHeaders.Clone()
    if ($InSolution) { $h['MSCRM.SolutionUniqueName'] = $schema.solution.uniqueName }
    $p = @{ Method = $Method; Uri = "$api/$Path"; Headers = $h }
    if ($null -ne $Body) {
        $p.ContentType = 'application/json; charset=utf-8'
        $p.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 20 -Compress))
    }
    Invoke-RestMethod @p
}

function Test-Dv([string] $Path) {
    try { Invoke-Dv GET $Path | Out-Null; $true }
    catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { return $false }
        throw
    }
}

function New-Label([string] $Text) {
    @{
        '@odata.type'   = 'Microsoft.Dynamics.CRM.Label'
        LocalizedLabels = @(@{ '@odata.type' = 'Microsoft.Dynamics.CRM.LocalizedLabel'; Label = $Text; LanguageCode = $lang })
    }
}

function New-ColumnBody($c) {
    $b = @{
        SchemaName    = $c.schemaName
        DisplayName   = New-Label $c.displayName
        Description   = New-Label $c.description
        RequiredLevel = @{ Value = $(if ($c.required) { $c.required } else { 'None' }) }
    }
    switch ($c.type) {
        'Text' {
            $b['@odata.type'] = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
            $b.MaxLength = $(if ($c.maxLength) { [int]$c.maxLength } else { 100 })
            $b.FormatName = @{ Value = 'Text' }
        }
        'Integer' {
            $b['@odata.type'] = 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata'
            $b.Format = 'None'; $b.MinValue = -2147483648; $b.MaxValue = 2147483647
        }
        'DateTime' {
            $b['@odata.type'] = 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata'
            $b.Format = 'DateAndTime'
            $b.DateTimeBehavior = @{ Value = 'UserLocal' }
        }
        'YesNo' {
            $b['@odata.type'] = 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata'
            $b.DefaultValue = $false
            $b.OptionSet = @{
                '@odata.type' = 'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata'
                OptionSetType = 'Boolean'
                TrueOption    = @{ Value = 1; Label = New-Label 'Yes' }
                FalseOption   = @{ Value = 0; Label = New-Label 'No' }
            }
        }
        'Choice' {
            $b['@odata.type'] = 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata'
            $b.OptionSet = @{
                '@odata.type' = 'Microsoft.Dynamics.CRM.OptionSetMetadata'
                IsGlobal      = $false
                OptionSetType = 'Picklist'
                Options       = @($c.options | ForEach-Object { @{ Value = [int]$_.value; Label = New-Label $_.label } })
            }
        }
        default { throw "Unsupported column type '$($c.type)' for $($c.schemaName)." }
    }
    $b
}

# 1. Publisher
$pub = $schema.publisher
$existingPub = (Invoke-Dv GET "publishers?`$select=publisherid,customizationprefix&`$filter=uniquename eq '$($pub.uniqueName)'").value
if ($existingPub) {
    $publisherId = $existingPub[0].publisherid
    if ($existingPub[0].customizationprefix -ne $pub.prefix) {
        throw "Publisher $($pub.uniqueName) exists with prefix '$($existingPub[0].customizationprefix)', expected '$($pub.prefix)'."
    }
    Write-Host "Publisher $($pub.uniqueName) exists."
} else {
    Invoke-Dv POST 'publishers' @{
        uniquename = $pub.uniqueName; friendlyname = $pub.friendlyName
        customizationprefix = $pub.prefix; customizationoptionvalueprefix = [int]$pub.optionValuePrefix
    } | Out-Null
    $publisherId = (Invoke-Dv GET "publishers?`$select=publisherid&`$filter=uniquename eq '$($pub.uniqueName)'").value[0].publisherid
    Write-Host "Created publisher $($pub.uniqueName)."
}

# 2. Solution
$sol = $schema.solution
if ((Invoke-Dv GET "solutions?`$select=solutionid&`$filter=uniquename eq '$($sol.uniqueName)'").value) {
    Write-Host "Solution $($sol.uniqueName) exists."
} else {
    Invoke-Dv POST 'solutions' @{
        uniquename = $sol.uniqueName; friendlyname = $sol.friendlyName; version = $sol.version
        description = $sol.description; 'publisherid@odata.bind' = "/publishers($publisherId)"
    } | Out-Null
    Write-Host "Created solution $($sol.uniqueName) $($sol.version)."
}

# 3. Tables and columns
foreach ($t in $schema.tables) {
    $tablePath = "EntityDefinitions(LogicalName='$($t.logicalName)')"
    if ($t.create -and -not (Test-Dv "$tablePath`?`$select=LogicalName")) {
        $pn = $t.primaryName
        Invoke-Dv POST 'EntityDefinitions' -InSolution @{
            '@odata.type'         = 'Microsoft.Dynamics.CRM.EntityMetadata'
            SchemaName            = $t.schemaName
            DisplayName           = New-Label $t.displayName
            DisplayCollectionName = New-Label $t.pluralName
            Description           = New-Label $t.description
            OwnershipType         = $t.ownership
            IsActivity            = $false
            HasActivities         = $false
            HasNotes              = $true
            Attributes            = @(@{
                '@odata.type' = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
                SchemaName    = $pn.schemaName
                IsPrimaryName = $true
                MaxLength     = [int]$pn.maxLength
                FormatName    = @{ Value = 'Text' }
                RequiredLevel = @{ Value = 'None' }
                DisplayName   = New-Label $pn.displayName
                Description   = New-Label $pn.description
            })
        } | Out-Null
        Write-Host "Created table $($t.logicalName)."
    } elseif (-not (Test-Dv "$tablePath`?`$select=LogicalName")) {
        throw "Table $($t.logicalName) does not exist and is not marked create: true."
    } else {
        Write-Host "Table $($t.logicalName) exists."
    }

    foreach ($c in $t.columns) {
        $logical = $c.schemaName.ToLowerInvariant()
        if (Test-Dv "$tablePath/Attributes(LogicalName='$logical')?`$select=LogicalName") {
            Write-Host "  Column $logical exists."
            continue
        }
        Invoke-Dv POST "$tablePath/Attributes" (New-ColumnBody $c) -InSolution | Out-Null
        Write-Host "  Created column $logical ($($c.type))."
    }
}

# 4. Lookups (one-to-many relationships)
foreach ($l in $schema.lookups) {
    if (Test-Dv "RelationshipDefinitions(SchemaName='$($l.relationshipSchemaName)')?`$select=SchemaName") {
        Write-Host "Relationship $($l.relationshipSchemaName) exists."
        continue
    }
    $referencedPk = (Invoke-Dv GET "EntityDefinitions(LogicalName='$($l.referencedTable)')?`$select=PrimaryIdAttribute").PrimaryIdAttribute
    Invoke-Dv POST 'RelationshipDefinitions' -InSolution @{
        '@odata.type'                         = 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata'
        SchemaName                            = $l.relationshipSchemaName
        ReferencedEntity                      = $l.referencedTable
        ReferencedAttribute                   = $referencedPk
        ReferencingEntity                     = $l.referencingTable
        ReferencingEntityNavigationPropertyName = $l.referencingNavigationProperty
        ReferencedEntityNavigationPropertyName  = $l.referencedNavigationProperty
        CascadeConfiguration                  = @{
            Assign = 'NoCascade'; Delete = $l.deleteBehavior; Merge = 'NoCascade'
            Reparent = 'NoCascade'; Share = 'NoCascade'; Unshare = 'NoCascade'
        }
        Lookup                                = @{
            '@odata.type' = 'Microsoft.Dynamics.CRM.LookupAttributeMetadata'
            SchemaName    = $l.lookupSchemaName
            DisplayName   = New-Label $l.displayName
            Description   = New-Label $l.description
            RequiredLevel = @{ Value = 'None' }
        }
    } | Out-Null
    Write-Host "Created lookup $($l.lookupSchemaName) ($($l.referencingTable) -> $($l.referencedTable))."
}

# 5. Publish the touched tables
$entities = ($schema.tables | ForEach-Object { "<entity>$($_.logicalName)</entity>" }) -join ''
Invoke-Dv POST 'PublishXml' @{ ParameterXml = "<importexportxml><entities>$entities</entities></importexportxml>" } | Out-Null
Write-Host "Published. Schema is in solution $($sol.uniqueName)."
