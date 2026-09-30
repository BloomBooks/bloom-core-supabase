#Requires -Version 5.1
<#
.SYNOPSIS
    Bloom Cloud Team Collections support tool: move a person to a new login (a new
    BloomLibrary/Firebase account), keeping their memberships, checkouts and history.

.DESCRIPTION
    For the Bloom team, when someone changes their email and ends up with a new Firebase
    account (a new uid). If Firebase kept the uid, nothing is needed: the person's next
    sign-in updates their email by itself.

    Calls tc.support_move_user_to_login through PostgREST with the project's SERVICE-ROLE key
    (the function is not callable by signed-in users). It finds the person by their current
    email in core.users and sets the row's authentication_id (the new account's Firebase uid)
    and email. Every identity column in the tc schema points at that row, so the person's
    memberships, checkouts and history follow them.

    It refuses if the new login or the new email already belongs to another user row (the
    person signed in with the new account before the move and joined something, or the email
    is someone else's): combining two users is a merge, which this script does not do.

    By default the script only CHECKS that the move is possible and reports it. Pass -Execute
    to make it.

    See team-collections/docs/GOING-LIVE.md, "Moving a user to a new login".

.PARAMETER CurrentEmail
    The email the person's user row has now (their old sign-in email).

.PARAMETER AuthenticationId
    The new account's sign-in id: its Firebase uid (Firebase console -> Authentication -> Users).

.PARAMETER NewEmail
    The new account's email.

.PARAMETER SupabaseUrl
    The project URL, e.g. https://<ref>.supabase.co (local stack: http://127.0.0.1:54321).

.PARAMETER ServiceRoleKey
    The project's service-role key (Dashboard -> Project Settings -> API). Never commit it.
    Defaults to $env:SUPABASE_SERVICE_ROLE_KEY.

.PARAMETER Execute
    Actually move. Without it the script checks and reports, and changes nothing.

.EXAMPLE
    .\move-user-to-login.ps1 -CurrentEmail old@example.org -AuthenticationId <new Firebase uid> `
        -NewEmail new@example.org -SupabaseUrl https://<ref>.supabase.co
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $CurrentEmail,
    [Parameter(Mandatory = $true)] [string] $AuthenticationId,
    [Parameter(Mandatory = $true)] [string] $NewEmail,
    [Parameter(Mandatory = $true)] [string] $SupabaseUrl,
    [string] $ServiceRoleKey = $env:SUPABASE_SERVICE_ROLE_KEY,
    [switch] $Execute
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $ServiceRoleKey) { throw "-ServiceRoleKey (or `$env:SUPABASE_SERVICE_ROLE_KEY) is required." }

$mode = if ($Execute) { "MOVING" } else { "CHECK ONLY (pass -Execute to move)" }
Write-Host "$CurrentEmail -> login $AuthenticationId, email $NewEmail - $mode"

$headers = @{
    "apikey"          = $ServiceRoleKey
    "Content-Profile" = "tc"
    "Accept-Profile"  = "tc"
}
# A legacy (JWT) service-role key also goes in Authorization; the newer sb_secret_ keys are
# accepted in apikey alone.
if (-not $ServiceRoleKey.StartsWith("sb_secret_")) {
    $headers["Authorization"] = "Bearer $ServiceRoleKey"
}
$body = @{
    p_current_email     = $CurrentEmail
    p_authentication_id = $AuthenticationId
    p_email             = $NewEmail
    p_dry_run           = (-not $Execute)
} | ConvertTo-Json -Compress

try {
    $result = Invoke-RestMethod -Method Post -Uri "$($SupabaseUrl.TrimEnd('/'))/rest/v1/rpc/support_move_user_to_login" `
        -Headers $headers -ContentType "application/json" -Body $body
} catch {
    # PostgREST puts the function's refusal (user_not_found, login_has_user, email_has_user) in
    # the response body's message.
    $detail = $_.ErrorDetails.Message
    if ($detail) { throw "Refused: $((ConvertFrom-Json $detail).message)" }
    throw
}

Write-Host "User $($result.userId):"
Write-Host ("  login  {0} -> {1}" -f $result.oldAuthenticationId, $result.authenticationId)
Write-Host ("  email  {0} -> {1}" -f $result.oldEmail, $result.email)
if ($result.moved) {
    Write-Host "Moved. The person signs in with the new account and carries on." -ForegroundColor Green
} else {
    Write-Host "The move is possible. Nothing was changed; re-run with -Execute to move." -ForegroundColor Yellow
}
