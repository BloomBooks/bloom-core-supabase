#Requires -Version 5.1
<#
.SYNOPSIS
    Bloom Cloud Team Collections support tool: permanently delete one cloud collection, its
    database rows and its S3 objects (every version), by collection id.

.DESCRIPTION
    For the Bloom team, typically to clear away a cloud collection whose initial upload failed
    (see team-collections/docs/GOING-LIVE.md, "Deleting a failed migration"). Two parts:

      1. Database: calls tc.support_delete_collection(collection_id) through PostgREST with
         the project's SERVICE-ROLE key (the function is not callable by signed-in users). It
         deletes the collection row and every tc row that belongs to it, and returns how many
         rows of each table went. An unknown id is reported as "not found", not an error, so
         re-running the script after a partial failure is safe.
      2. S3: deletes every object version and delete marker under tc/<collectionId>/ in the
         bucket (the bucket is versioned, so an ordinary `aws s3 rm --recursive` would only add
         delete markers and keep the data). Uses the AWS CLI, as provision-aws.ps1 does; pass
         -EndpointUrl for the local MinIO stack.

    By default the script only REPORTS what it would delete (the database's row counts and the
    number of S3 versions). Pass -Execute to delete.

    The database part runs first: once the rows are gone, no one can obtain new S3 credentials
    for the collection (every edge function checks membership). Credentials already vended
    stay valid for up to an hour, so make sure the admin's Bloom is closed (or run the script
    again an hour later; the S3 part is idempotent).

.PARAMETER CollectionId
    The collection's id (tc.collections.id, the Bloom CollectionId GUID).

.PARAMETER SupabaseUrl
    The project URL, e.g. https://<ref>.supabase.co (local stack: http://127.0.0.1:54321).

.PARAMETER ServiceRoleKey
    The project's service-role key (Dashboard -> Project Settings -> API). Never commit it.
    Defaults to $env:SUPABASE_SERVICE_ROLE_KEY.

.PARAMETER Bucket
    The S3 bucket, e.g. bloom-teams-production (local stack: bloom-teams-local).

.PARAMETER Region
    AWS region of the bucket. Default: us-east-1.

.PARAMETER AwsProfile
    Named AWS CLI profile (`aws --profile <name>`). Leave unset for the default credential chain.

.PARAMETER EndpointUrl
    S3 endpoint override for MinIO, e.g. http://127.0.0.1:9000 (with AWS_ACCESS_KEY_ID /
    AWS_SECRET_ACCESS_KEY set to the MinIO credentials). Leave unset for real AWS.

.PARAMETER SkipDatabase
    Only do the S3 part (e.g. finishing a run whose S3 part failed).

.PARAMETER SkipS3
    Only do the database part.

.PARAMETER Execute
    Actually delete. Without it the script reports what it would delete and changes nothing.

.EXAMPLE
    # Local stack, report only:
    $env:AWS_ACCESS_KEY_ID = "minioadmin"; $env:AWS_SECRET_ACCESS_KEY = "minioadmin"
    .\delete-collection.ps1 -CollectionId <uuid> -SupabaseUrl http://127.0.0.1:54321 `
        -ServiceRoleKey <local service_role key> -Bucket bloom-teams-local -EndpointUrl http://127.0.0.1:9000

.NOTES
    Requires the AWS CLI v2 on PATH for the S3 part.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [guid]  $CollectionId,
    [string] $SupabaseUrl    = "",
    [string] $ServiceRoleKey = $env:SUPABASE_SERVICE_ROLE_KEY,
    [string] $Bucket         = "",
    [string] $Region         = "us-east-1",
    [string] $AwsProfile     = "",
    [string] $EndpointUrl    = "",
    [switch] $SkipDatabase,
    [switch] $SkipS3,
    [switch] $Execute
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$cid = $CollectionId.ToString().ToLowerInvariant()
$prefix = "tc/$cid/"
$mode = if ($Execute) { "DELETING" } else { "REPORT ONLY (pass -Execute to delete)" }
Write-Host "Collection $cid - $mode"

# ---------------------------------------------------------------------------------------------
# 1. Database
# ---------------------------------------------------------------------------------------------
if (-not $SkipDatabase) {
    if (-not $SupabaseUrl) { throw "-SupabaseUrl is required (or pass -SkipDatabase)." }
    if (-not $ServiceRoleKey) { throw "-ServiceRoleKey (or `$env:SUPABASE_SERVICE_ROLE_KEY) is required (or pass -SkipDatabase)." }

    $headers = @{
        "apikey"          = $ServiceRoleKey
        "Content-Profile" = "tc"
        "Accept-Profile"  = "tc"
    }
    # A legacy (JWT) service-role key also goes in Authorization; the newer sb_secret_ keys
    # are accepted in apikey alone.
    if (-not $ServiceRoleKey.StartsWith("sb_secret_")) {
        $headers["Authorization"] = "Bearer $ServiceRoleKey"
    }
    $body = @{ p_collection_id = $cid; p_dry_run = (-not $Execute) } | ConvertTo-Json -Compress
    $result = Invoke-RestMethod -Method Post -Uri "$($SupabaseUrl.TrimEnd('/'))/rest/v1/rpc/support_delete_collection" `
        -Headers $headers -ContentType "application/json" -Body $body

    if (-not $result.found) {
        Write-Host "Database: no such collection (already deleted?)." -ForegroundColor Yellow
    } else {
        $verb = if ($Execute) { "deleted" } else { "would delete" }
        Write-Host "Database: '$($result.name)' - $verb these rows:"
        $result.rows.PSObject.Properties | ForEach-Object { Write-Host ("  {0,-30} {1}" -f $_.Name, $_.Value) }
    }
}

# ---------------------------------------------------------------------------------------------
# 2. S3: every version and delete marker under tc/<cid>/
# ---------------------------------------------------------------------------------------------
function Invoke-Aws([string[]]$Arguments) {
    $full = @($Arguments) + @("--region", $Region, "--output", "json")
    if ($AwsProfile) { $full += @("--profile", $AwsProfile) }
    if ($EndpointUrl) { $full += @("--endpoint-url", $EndpointUrl) }
    $output = & aws @full 2>&1
    if ($LASTEXITCODE -ne 0) { throw "aws $($Arguments -join ' ') failed (exit $LASTEXITCODE):`n$output" }
    $text = ($output | Out-String).Trim()
    if ($text) { return $text | ConvertFrom-Json }
    return $null
}

# Writes UTF-8 with no BOM (the aws CLI rejects a BOM at the start of a file:// JSON document).
function Write-JsonNoBom([string]$Path, [string]$Json) {
    [System.IO.File]::WriteAllText($Path, $Json, (New-Object System.Text.UTF8Encoding($false)))
}

if (-not $SkipS3) {
    if (-not $Bucket) { throw "-Bucket is required (or pass -SkipS3)." }
    if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "The AWS CLI (aws) is not on PATH." }

    # Lists every version and delete marker under the prefix (the CLI follows the pages).
    function Get-PrefixVersions {
        $listing = Invoke-Aws @("s3api", "list-object-versions", "--bucket", $Bucket, "--prefix", $prefix)
        $found = @()
        if ($listing) {
            foreach ($listName in @("Versions", "DeleteMarkers")) {
                if ($listing.PSObject.Properties[$listName] -and $listing.$listName) {
                    $found += @($listing.$listName | ForEach-Object { @{ Key = $_.Key; VersionId = $_.VersionId } })
                }
            }
        }
        # Never touch anything outside the collection's prefix.
        return ,@($found | Where-Object { $_.Key.StartsWith($prefix) })
    }

    $objects = Get-PrefixVersions
    $total = $objects.Count
    if ($Execute -and $total -gt 0) {
        # delete-objects takes at most 1000 keys per call.
        for ($i = 0; $i -lt $total; $i += 1000) {
            $batch = @($objects[$i..([Math]::Min($i + 999, $total - 1))])
            $tmp = [System.IO.Path]::GetTempFileName()
            try {
                Write-JsonNoBom $tmp (@{ Objects = $batch; Quiet = $true } | ConvertTo-Json -Depth 4 -Compress)
                $deleted = Invoke-Aws @("s3api", "delete-objects", "--bucket", $Bucket, "--delete", "file://$tmp")
                if ($deleted -and $deleted.PSObject.Properties["Errors"] -and $deleted.Errors) {
                    throw "S3 refused to delete some objects:`n$($deleted.Errors | ConvertTo-Json -Depth 4)"
                }
            } finally {
                Remove-Item $tmp -ErrorAction SilentlyContinue
            }
        }
        $left = (Get-PrefixVersions).Count
        if ($left -gt 0) {
            throw "$left object versions are still under s3://$Bucket/$prefix (an upload still in progress?); run the script again."
        }
    }
    $verb = if ($Execute) { "deleted" } else { "would delete" }
    Write-Host "S3: $verb $total object versions/delete markers under s3://$Bucket/$prefix"
}

if (-not $Execute) {
    Write-Host "Nothing was changed. Re-run with -Execute to delete." -ForegroundColor Yellow
}
