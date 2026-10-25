# Local, manually invoked only. No environment files, database clients or logout calls.
# Requires an interactive PowerShell 5.1+ console. Only optional argument: -Port NUMBER.
$ErrorActionPreference = 'Stop'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$script:Failed = $false

function Write-TestResult {
    param([string]$Name, [int]$Status, [bool]$Passed)
    $statusText = if ($Status -gt 0) { [string]$Status } else { '--' }
    $resultText = if ($Passed) { 'PASS' } else { 'FAIL' }
    [Console]::WriteLine(('{0} | HTTP {1} | {2}' -f $Name, $statusText, $resultText))
    if (-not $Passed) { $script:Failed = $true }
}

function Convert-SecretInMemory {
    param([Security.SecureString]$Value)
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

function Test-ExactKeys {
    param($Value, [string[]]$Keys)
    if ($null -eq $Value -or $Value -isnot [PSCustomObject]) { return $false }
    $actual = @($Value.PSObject.Properties.Name)
    if ($actual.Count -ne $Keys.Count) { return $false }
    foreach ($key in $Keys) { if ($actual -cnotcontains $key) { return $false } }
    return $true
}

function Test-SafeAdmin {
    param($User, [string]$ExpectedEmail, [string]$ExpectedId)
    if (-not (Test-ExactKeys $User @('_id', 'email', 'role'))) { return $false }
    if ($User._id -isnot [string] -or $User._id -cnotmatch '^[a-f0-9]{24}$' -or
        $User.email -isnot [string] -or $User.email -cne $ExpectedEmail -or
        $User.role -isnot [string] -or $User.role -cne 'admin') { return $false }
    if ($ExpectedId -and $User._id -cne $ExpectedId) { return $false }
    return $true
}

function Invoke-LocalCheck {
    param($Client, [string]$Method, [string]$Path, $Payload, [string]$Bearer)
    $request = $null
    $response = $null
    $json = $null
    $body = $null
    $status = 0
    try {
        # Defense in depth: no arbitrary hosts, paths, redirects or mutation endpoints.
        if ($Client.BaseAddress.Scheme -cne 'http' -or $Client.BaseAddress.Host -cne '127.0.0.1') { throw 'Invalid local target' }
        if (-not (($Method -ceq 'POST' -and $Path -ceq '/api/auth/login') -or
            ($Method -ceq 'GET' -and @('/api/me', '/api/health') -ccontains $Path))) { throw 'Invalid check' }
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Path)
        if ($null -ne $Payload) {
            $json = $Payload | ConvertTo-Json -Compress
            $request.Content = [System.Net.Http.StringContent]::new($json, [Text.Encoding]::UTF8, 'application/json')
        }
        if ($Bearer) {
            $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Bearer)
        }
        $response = $Client.SendAsync($request).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $data = $body | ConvertFrom-Json
        return [PSCustomObject]@{ Status = $status; Data = $data }
    }
    catch {
        # Never print exception text: it can contain request/response data.
        return [PSCustomObject]@{ Status = $status; Data = $null }
    }
    finally {
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $request) { $request.Dispose() }
        $Payload = $null; $Bearer = $null; $json = $null; $body = $null; $data = $null
    }
}

$client = $null; $handler = $null
$emailSecure = $null; $passwordSecure = $null
$email = $null; $password = $null; $token = $null; $wrongPassword = $null
$login = $null; $wrong = $null; $me = $null; $health = $null; $payload = $null
try {
    $port = 5000
    if ($args.Count -ne 0) {
        if ($args.Count -ne 2 -or $args[0] -cne '-Port' -or
            -not [int]::TryParse([string]$args[1], [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
            throw 'Invalid arguments'
        }
    }
    if ($Host.Name -ne 'ConsoleHost' -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
        throw 'Interactive console required'
    }
    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseProxy = $false
    $handler.UseCookies = $false
    $handler.UseDefaultCredentials = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.BaseAddress = [Uri]('http://127.0.0.1:' + $port)
    $client.Timeout = [TimeSpan]::FromSeconds(10)
    $client.MaxResponseContentBufferSize = 65536

    # Both credentials are hidden, never read from arguments, environment or disk.
    $emailSecure = Read-Host 'Admin email (hidden)' -AsSecureString
    $passwordSecure = Read-Host 'Admin password (hidden)' -AsSecureString
    $email = (Convert-SecretInMemory $emailSecure).Trim().ToLowerInvariant()
    $password = Convert-SecretInMemory $passwordSecure
    if (-not $email -or -not $password -or [Text.Encoding]::UTF8.GetByteCount($password) -gt 72 -or $password.Contains([string][char]0)) {
        throw 'Invalid interactive input'
    }

    $payload = @{ email = $email; password = $password }
    $login = Invoke-LocalCheck $client 'POST' '/api/auth/login' $payload $null
    $payload = $null
    $valid = $login.Status -eq 200 -and
        (Test-ExactKeys $login.Data @('accessToken', 'tokenType', 'expiresIn', 'user')) -and
        (Test-SafeAdmin $login.Data.user $email '') -and
        $login.Data.accessToken -is [string] -and
        $login.Data.accessToken -cmatch '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' -and
        $login.Data.tokenType -is [string] -and $login.Data.tokenType -ceq 'Bearer' -and
        ($login.Data.expiresIn -is [int] -or $login.Data.expiresIn -is [long]) -and $login.Data.expiresIn -eq 900
    Write-TestResult 'Valid admin login and safe DTO' $login.Status $valid
    $userId = $null
    if ($valid) { $token = $login.Data.accessToken; $userId = $login.Data.user._id }
    $login = $null

    do { $wrongPassword = 'smoke-' + [Guid]::NewGuid().ToString('N') } while ($wrongPassword -ceq $password)
    $wrong = Invoke-LocalCheck $client 'POST' '/api/auth/login' @{ email = $email; password = $wrongPassword } $null
    $rejected = $wrong.Status -eq 401 -and (Test-ExactKeys $wrong.Data @('error')) -and
        $wrong.Data.error -is [string] -and $wrong.Data.error -ceq 'Authentication required or invalid credentials'
    Write-TestResult 'Incorrect password rejection' $wrong.Status $rejected
    $wrong = $null; $wrongPassword = $null; $password = $null
    $passwordSecure.Dispose(); $passwordSecure = $null

    if ($token) {
        $me = Invoke-LocalCheck $client 'GET' '/api/me' $null $token
        $safeMe = $me.Status -eq 200 -and (Test-ExactKeys $me.Data @('user')) -and
            (Test-SafeAdmin $me.Data.user $email $userId)
        Write-TestResult 'Authenticated current user and safe DTO' $me.Status $safeMe
    }
    else { Write-TestResult 'Authenticated current user (not performed)' 0 $false }
    $me = $null; $token = $null

    $health = Invoke-LocalCheck $client 'GET' '/api/health' $null $null
    $healthy = $health.Status -eq 200 -and
        (Test-ExactKeys $health.Data @('status', 'service', 'database')) -and
        $health.Data.status -is [string] -and $health.Data.status -ceq 'ok' -and
        $health.Data.service -is [string] -and $health.Data.service -ceq 'bookleaf-api' -and
        $health.Data.database -is [string] -and $health.Data.database -ceq 'connected'
    Write-TestResult 'Public connected health' $health.Status $healthy
}
catch { Write-TestResult 'Local smoke test setup or execution' 0 $false }
finally {
    if ($null -ne $client) { $client.Dispose() }
    if ($null -ne $handler) { $handler.Dispose() }
    if ($null -ne $emailSecure) { $emailSecure.Dispose() }
    if ($null -ne $passwordSecure) { $passwordSecure.Dispose() }
    $email = $null; $password = $null; $token = $null; $wrongPassword = $null
    $login = $null; $wrong = $null; $me = $null; $health = $null; $payload = $null; $userId = $null
}
if ($script:Failed) { exit 1 }
exit 0
