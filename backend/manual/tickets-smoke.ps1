# Manual live integration test. PowerShell 5.1+; optional -Port NUMBER only.
# Creates retained smoke records. Never dot-source, trace, record or redirect this script.
$ErrorActionPreference = 'Stop'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$script:Failed = $false; $script:Incomplete = $false
$script:Reported = [System.Collections.Generic.HashSet[string]]::new()
$script:CreatedTicketId = $null; $script:CreateAttempted = $false
$script:CreateStatus = 0; $script:AuthorVerified = $false; $script:SmokeVerified = $false
$script:Subject = 'MANUAL-SMOKE-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N')
$script:Reply = 'Manual smoke public reply ' + [Guid]::NewGuid().ToString('N')
$script:Note = 'Manual smoke private note ' + [Guid]::NewGuid().ToString('N')
$script:TicketKeys = @('_id','subject','description','category','priority','status','createdAt','updatedAt','lastActivityAt','resolvedAt','closedAt','author','book','assignee')
$script:AdminKeys = @('categorySource','prioritySource','categoryOverriddenAt','priorityOverriddenAt','categoryOverriddenBy','priorityOverriddenBy','classification','revision')
$script:Checks = @('Admin login','Author login','Verify AUTH001 mapping before writes','Create unique smoke ticket',
    'Author lists smoke ticket','Author retrieves smoke ticket','Admin queue contains smoke ticket','Admin retrieves smoke ticket',
    'Admin adds public reply','Author sees public reply','Admin adds private note','Admin sees private note',
    'Author response excludes private note','Valid smoke ticket status update','Cross-author ticket hidden','Invalid ticket ID rejected')

function Write-TestResult {
    param([string]$Name,[int]$Status,[ValidateSet('PASS','FAIL','NOT PERFORMED')][string]$Result)
    $null = $script:Reported.Add($Name)
    $statusText = if ($Status -gt 0) { [string]$Status } else { '--' }
    [Console]::WriteLine(('{0} | HTTP {1} | {2}' -f $Name,$statusText,$Result))
    if ($Result -ceq 'FAIL') { $script:Failed = $true }
    if ($Result -ceq 'NOT PERFORMED') { $script:Incomplete = $true }
}
function Report-Check {
    param([string]$Name,[int]$Status,[bool]$Valid)
    $result = if ($Valid) { 'PASS' } else { 'FAIL' }
    Write-TestResult $Name $Status $result
}
function Test-Keys {
    param($Value,[string[]]$Keys)
    if ($Value -isnot [PSCustomObject]) { return $false }
    $actual = @($Value.PSObject.Properties.Name)
    if ($actual.Count -ne $Keys.Count) { return $false }
    foreach ($key in $Keys) { if ($actual -cnotcontains $key) { return $false } }
    return $true
}
function Test-Id { param($Value) return $Value -is [string] -and $Value -cmatch '^[a-f0-9]{24}$' }
function Test-Integer { param($Value) return ($Value -is [int] -or $Value -is [long]) -and $Value -ge 0 -and $Value -le 9007199254740991 }
function Test-NoPrivateFields {
    param($Value)
    if ($Value -is [PSCustomObject]) {
        foreach ($property in $Value.PSObject.Properties) {
            if (@('password','passwordHash','credentials','tokenVersion','internalNotes','notes','notesPagination','aiClassification','JWT_SECRET','MONGODB_URI') -contains $property.Name) { return $false }
            if (-not (Test-NoPrivateFields $property.Value)) { return $false }
        }
    }
    elseif ($Value -is [array]) { foreach ($item in $Value) { if (-not (Test-NoPrivateFields $item)) { return $false } } }
    return $true
}
function Test-Reference {
    param($Value,[ValidateSet('author','book','user')][string]$Kind)
    if ($null -eq $Value) { return $Kind -cne 'author' }
    if (Test-Id $Value) { return $true }
    $keys = switch ($Kind) { 'author' { @('_id','author_id','name') } 'book' { @('_id','book_id','title','isbn','status') } 'user' { @('_id','role') } }
    if (-not (Test-Keys $Value $keys) -or -not (Test-Id $Value._id)) { return $false }
    foreach ($key in $keys) { if ($Value.$key -isnot [string]) { return $false } }
    if ($Kind -ceq 'author') { return $Value.author_id -cmatch '^AUTH\d+$' }
    if ($Kind -ceq 'user') { return @('author','admin') -ccontains $Value.role }
    return $Value.book_id -cmatch '^BK\d+$'
}
function Test-Ticket {
    param($Value,[bool]$Admin)
    $keys = $script:TicketKeys
    if ($Admin) { $keys = $keys + $script:AdminKeys }
    if (-not (Test-Keys $Value $keys) -or -not (Test-NoPrivateFields $Value) -or -not (Test-Id $Value._id)) { return $false }
    if ($Value.subject -isnot [string] -or $Value.description -isnot [string] -or
        @('Open','In Progress','Resolved','Closed') -cnotcontains $Value.status -or
        @('Critical','High','Medium','Low') -cnotcontains $Value.priority) { return $false }
    if ($null -ne $Value.category -and $Value.category -isnot [string]) { return $false }
    foreach ($key in @('createdAt','updatedAt','lastActivityAt')) { if ($Value.$key -isnot [string]) { return $false } }
    foreach ($key in @('resolvedAt','closedAt')) { if ($null -ne $Value.$key -and $Value.$key -isnot [string]) { return $false } }
    return (Test-Reference $Value.author 'author') -and (Test-Reference $Value.book 'book') -and (Test-Reference $Value.assignee 'user')
}
function Get-ReferenceId { param($Value) if ($Value -is [string]) { return $Value }; return $Value._id }
function Test-Paging {
    param($Value,[int]$Page)
    return (Test-Keys $Value @('page','limit','total','totalPages')) -and
        (Test-Integer $Value.page) -and $Value.page -eq $Page -and $Value.limit -eq 50 -and
        (Test-Integer $Value.total) -and (Test-Integer $Value.totalPages) -and
        $Value.totalPages -eq [Math]::Ceiling($Value.total / 50.0) -and $Value.totalPages -le 100
}
function Test-Entry {
    param($Value,[bool]$Private)
    $keys = if ($Private) { @('_id','body','createdAt','updatedAt','ticket','createdBy') } else { @('_id','body','sentAt','createdAt','ticket','sender','attachments') }
    if (-not (Test-Keys $Value $keys) -or -not (Test-NoPrivateFields $Value) -or -not (Test-Id $Value._id) -or
        $Value.ticket -cne $script:CreatedTicketId -or $Value.body -isnot [string]) { return $false }
    if ($Private) { return (Test-Reference $Value.createdBy 'user') -and $null -ne $Value.createdBy }
    return (Test-Reference $Value.sender 'user') -and $null -ne $Value.sender -and $Value.attachments -is [array] -and $Value.attachments.Count -eq 0
}
function Test-Detail {
    param($Response,[bool]$Admin)
    $keys = @('ticket','messages','pagination')
    if ($Admin) { $keys = $keys + @('notes','notesPagination') }
    $value = $Response.Data
    if ($Response.Status -ne 200 -or -not (Test-Keys $value $keys) -or -not (Test-Ticket $value.ticket $Admin) -or
        $value.ticket._id -cne $script:CreatedTicketId -or $value.ticket.subject -cne $script:Subject -or
        $value.messages -isnot [array] -or -not (Test-Paging $value.pagination 1) -or $value.pagination.total -ne $value.messages.Count) { return $false }
    foreach ($message in $value.messages) { if (-not (Test-Entry $message $false)) { return $false } }
    if ($Admin) {
        if ($value.notes -isnot [array] -or -not (Test-Paging $value.notesPagination 1) -or $value.notesPagination.total -ne $value.notes.Count) { return $false }
        foreach ($note in $value.notes) { if (-not (Test-Entry $note $true)) { return $false } }
    }
    else {
        if (-not (Test-NoPrivateFields $value)) { return $false }
        $inMemoryJson = $value | ConvertTo-Json -Depth 20 -Compress
        if ($inMemoryJson.IndexOf($script:Note,[StringComparison]::Ordinal) -ge 0) { return $false }
    }
    return $true
}
function Convert-SecretInMemory {
    param([Security.SecureString]$Value)
    $pointer = [IntPtr]::Zero
    try { $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value); return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) } }
}
function Invoke-LocalCheck {
    param($Client,[string]$Method,[string]$Path,$Payload,[string]$Bearer,$Revision=$null)
    $request = $null; $response = $null; $json = $null; $body = $null; $data = $null; $status = 0
    try {
        if ($Client.BaseAddress.Scheme -cne 'http' -or $Client.BaseAddress.Host -cne '127.0.0.1') { throw 'Invalid local target' }
        $allowed = ($Method -ceq 'POST' -and $Path -ceq '/api/auth/login') -or
            ($Method -ceq 'GET' -and ($Path -cmatch '^/api/(me|admin)/(books|tickets)\?page=[1-9]\d*&limit=50$' -or
                $Path -cmatch '^/api/(me|admin)/tickets/[a-f0-9]{24}(\?page=1&limit=50|\?view=summary)?$' -or $Path -ceq '/api/me/tickets/not-a-ticket-id'))
        if ($Method -ceq 'POST' -and $Path -ceq '/api/me/tickets' -and $script:AuthorVerified -and -not $script:CreateAttempted) {
            $allowed = $true; $script:CreateAttempted = $true
        }
        # No write to any ticket except the freshly created, read-back-verified one.
        if ($script:SmokeVerified -and (Test-Id $script:CreatedTicketId)) {
            $root = '/api/admin/tickets/' + $script:CreatedTicketId
            if ($Method -ceq 'POST' -and @(($root + '/messages'),($root + '/notes')) -ccontains $Path) { $allowed = $true }
            if ($Method -ceq 'PATCH' -and $Path -ceq $root -and $Payload.status -ceq 'In Progress' -and @($Payload.Keys).Count -eq 1) { $allowed = $true }
        }
        if (-not $allowed) { throw 'Invalid check' }
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method),$Path)
        if ($null -ne $Payload) {
            $json = $Payload | ConvertTo-Json -Compress
            $request.Content = [System.Net.Http.StringContent]::new($json,[Text.Encoding]::UTF8,'application/json')
        }
        if ($Bearer) { $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$Bearer) }
        if ($Method -ceq 'PATCH') {
            if ($null -eq $Revision -or $Revision -isnot [ValueType] -or $Revision -lt 0) { throw 'Revision unavailable' }
            $null = $request.Headers.TryAddWithoutValidation('If-Match',('"{0}"' -f $Revision))
        }
        $response = $Client.SendAsync($request).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        if ($Method -ceq 'POST' -and $Path -ceq '/api/me/tickets') { $script:CreateStatus = $status }
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $data = $body | ConvertFrom-Json
        return [PSCustomObject]@{ Status = $status; Data = $data }
    }
    catch { return [PSCustomObject]@{ Status = $status; Data = $null } }
    finally {
        if ($null -ne $response) { $response.Dispose() }; if ($null -ne $request) { $request.Dispose() }
        $Payload = $null; $Bearer = $null; $json = $null; $body = $null; $data = $null
    }
}
function Read-Login {
    param($Client,[string]$Role)
    $emailSecure = $null; $passwordSecure = $null; $email = $null; $password = $null; $login = $null
    try {
        $emailSecure = Read-Host ($Role + ' email (hidden)') -AsSecureString
        $passwordSecure = Read-Host ($Role + ' password (hidden)') -AsSecureString
        $email = (Convert-SecretInMemory $emailSecure).Trim().ToLowerInvariant(); $password = Convert-SecretInMemory $passwordSecure
        if (-not $email -or -not $password -or [Text.Encoding]::UTF8.GetByteCount($password) -gt 72 -or $password.Contains([string][char]0)) { throw 'Invalid interactive input' }
        $login = Invoke-LocalCheck $Client 'POST' '/api/auth/login' @{email=$email;password=$password} $null
        $valid = $login.Status -eq 200 -and (Test-Keys $login.Data @('accessToken','tokenType','expiresIn','user')) -and
            (Test-Keys $login.Data.user @('_id','email','role')) -and (Test-Id $login.Data.user._id) -and
            $login.Data.user.email -ceq $email -and $login.Data.user.role -ceq $Role -and
            $login.Data.accessToken -is [string] -and $login.Data.accessToken -cmatch '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' -and
            $login.Data.tokenType -ceq 'Bearer' -and $login.Data.expiresIn -eq 900
        $label = if ($Role -ceq 'admin') { 'Admin login' } else { 'Author login' }
        Report-Check $label $login.Status $valid
        if ($valid) { return [PSCustomObject]@{Token=$login.Data.accessToken;UserId=$login.Data.user._id} }
        return $null
    }
    finally {
        if ($null -ne $emailSecure) { $emailSecure.Dispose() }; if ($null -ne $passwordSecure) { $passwordSecure.Dispose() }
        $email = $null; $password = $null; $login = $null
    }
}
function Read-Pages {
    param($Client,[string]$Bearer,[ValidateSet('books','tickets')][string]$Resource,[bool]$Admin)
    $rolePath = if ($Admin) { 'admin' } else { 'me' }
    $items = [System.Collections.Generic.List[object]]::new()
    $ids = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $total = -1; $pages = 1; $status = 0
    for ($page=1; $page -le $pages; $page++) {
        $response = Invoke-LocalCheck $Client 'GET' ('/api/'+$rolePath+'/'+$Resource+'?page='+$page+'&limit=50') $null $Bearer
        $status = $response.Status
        if ($status -ne 200 -or -not (Test-Keys $response.Data @($Resource,'pagination')) -or
            $response.Data.$Resource -isnot [array] -or -not (Test-Paging $response.Data.pagination $page)) { break }
        $paging = $response.Data.pagination
        if ($total -eq -1) { $total=$paging.total; $pages=[Math]::Max(1,$paging.totalPages) }
        if ($paging.total -ne $total -or $response.Data.$Resource.Count -ne [Math]::Min(50,[Math]::Max(0,$total-(($page-1)*50)))) { break }
        $valid = $true
        foreach ($item in $response.Data.$Resource) {
            if ($Resource -ceq 'tickets') { $valid = Test-Ticket $item $Admin; $key=$item._id }
            else {
                $valid = $item -is [PSCustomObject] -and (Test-NoPrivateFields $item) -and $item.book_id -is [string] -and $item.book_id -cmatch '^BK\d+$'
                if ($Admin) { $valid = $valid -and (Test-Reference $item.author 'author') -and $item.author -is [PSCustomObject] }
                $key=$item.book_id
            }
            if (-not $valid -or -not $ids.Add($key)) { $valid=$false; break }
            $items.Add($item)
        }
        if (-not $valid) { break }
        if ($page -eq $pages -and $items.Count -eq $total) { return [PSCustomObject]@{Status=$status;Valid=$true;Items=$items.ToArray()} }
    }
    return [PSCustomObject]@{Status=$status;Valid=$false;Items=@()}
}

function Invoke-TicketWorkflow {
    param($Client,$Admin,$Author)
    if ($null -eq $Admin -or $null -eq $Author) { return }
    $adminBooks = Read-Pages $Client $Admin.Token 'books' $true
    $authorBooks = Read-Pages $Client $Author.Token 'books' $false
    $expected = @($adminBooks.Items | Where-Object {$_.author.author_id -ceq 'AUTH001'})
    $authorIds = @($expected | ForEach-Object {$_.author._id} | Sort-Object -Unique)
    $actual = @($authorBooks.Items | ForEach-Object {$_.book_id})
    $expectedIds = @($expected | ForEach-Object {$_.book_id})
    $valid = $adminBooks.Valid -and $authorBooks.Valid -and $expected.Count -gt 0 -and $authorIds.Count -eq 1 -and $actual.Count -eq $expectedIds.Count
    foreach ($bookId in $actual) { if ($expectedIds -cnotcontains $bookId) { $valid=$false } }
    Report-Check 'Verify AUTH001 mapping before writes' $authorBooks.Status $valid
    if (-not $valid) { return }; $script:AuthorVerified=$true; $authorId=$authorIds[0]

    $created = Invoke-LocalCheck $Client 'POST' '/api/me/tickets' @{subject=$script:Subject;description='Local manual integration smoke test. Retain for operator cleanup.'} $Author.Token
    $valid = $created.Status -eq 201 -and (Test-Keys $created.Data @('ticket')) -and (Test-Ticket $created.Data.ticket $false) -and
        $created.Data.ticket.subject -ceq $script:Subject -and (Get-ReferenceId $created.Data.ticket.author) -ceq $authorId -and $created.Data.ticket.status -ceq 'Open'
    Report-Check 'Create unique smoke ticket' $created.Status $valid
    if (-not $valid) { return }; $script:CreatedTicketId=$created.Data.ticket._id
    $authorPath='/api/me/tickets/'+$script:CreatedTicketId; $adminPath='/api/admin/tickets/'+$script:CreatedTicketId

    $listed = Read-Pages $Client $Author.Token 'tickets' $false
    $found = @($listed.Items | Where-Object {$_.subject -ceq $script:Subject -and $_._id -ceq $script:CreatedTicketId})
    Report-Check 'Author lists smoke ticket' $listed.Status ($listed.Valid -and $found.Count -eq 1)
    $detail = Invoke-LocalCheck $Client 'GET' ($authorPath+'?page=1&limit=50') $null $Author.Token
    $valid = (Test-Detail $detail $false) -and (Get-ReferenceId $detail.Data.ticket.author) -ceq $authorId
    Report-Check 'Author retrieves smoke ticket' $detail.Status $valid

    $queue = Read-Pages $Client $Admin.Token 'tickets' $true
    $found = @($queue.Items | Where-Object {$_.subject -ceq $script:Subject -and $_._id -ceq $script:CreatedTicketId})
    Report-Check 'Admin queue contains smoke ticket' $queue.Status ($queue.Valid -and $found.Count -eq 1)
    $detail = Invoke-LocalCheck $Client 'GET' ($adminPath+'?page=1&limit=50') $null $Admin.Token
    $valid = (Test-Detail $detail $true) -and $detail.Data.ticket.author.author_id -ceq 'AUTH001' -and
        (Get-ReferenceId $detail.Data.ticket.author) -ceq $authorId -and $detail.Data.ticket.status -ceq 'Open'
    Report-Check 'Admin retrieves smoke ticket' $detail.Status $valid
    if (-not $valid) { return }; $script:SmokeVerified=$true

    $reply = Invoke-LocalCheck $Client 'POST' ($adminPath+'/messages') @{body=$script:Reply} $Admin.Token
    $valid = $reply.Status -eq 201 -and (Test-Keys $reply.Data @('message')) -and (Test-Entry $reply.Data.message $false) -and
        $reply.Data.message.body -ceq $script:Reply -and (Get-ReferenceId $reply.Data.message.sender) -ceq $Admin.UserId
    Report-Check 'Admin adds public reply' $reply.Status $valid
    $detail = Invoke-LocalCheck $Client 'GET' ($authorPath+'?page=1&limit=50') $null $Author.Token
    $seen = @($detail.Data.messages | Where-Object {$_.body -ceq $script:Reply -and (Get-ReferenceId $_.sender) -ceq $Admin.UserId})
    Report-Check 'Author sees public reply' $detail.Status ((Test-Detail $detail $false) -and $seen.Count -eq 1)

    $note = Invoke-LocalCheck $Client 'POST' ($adminPath+'/notes') @{body=$script:Note} $Admin.Token
    $valid = $note.Status -eq 201 -and (Test-Keys $note.Data @('note')) -and (Test-Entry $note.Data.note $true) -and
        $note.Data.note.body -ceq $script:Note -and (Get-ReferenceId $note.Data.note.createdBy) -ceq $Admin.UserId
    Report-Check 'Admin adds private note' $note.Status $valid
    $detail = Invoke-LocalCheck $Client 'GET' ($adminPath+'?page=1&limit=50') $null $Admin.Token
    $seen = @($detail.Data.notes | Where-Object {$_.body -ceq $script:Note -and (Get-ReferenceId $_.createdBy) -ceq $Admin.UserId})
    $noteVisible = (Test-Detail $detail $true) -and $seen.Count -eq 1
    Report-Check 'Admin sees private note' $detail.Status $noteVisible
    $detail = Invoke-LocalCheck $Client 'GET' ($authorPath+'?page=1&limit=50') $null $Author.Token
    if ($noteVisible) { Report-Check 'Author response excludes private note' $detail.Status (Test-Detail $detail $false) }
    # Otherwise the privacy check stays NOT PERFORMED: absence proves nothing if note creation failed.

    $current = Invoke-LocalCheck $Client 'GET' ($adminPath+'?view=summary') $null $Admin.Token
    $revision = if ($current.Status -eq 200 -and $null -ne $current.Data.ticket) { $current.Data.ticket.revision } else { $null }
    $changed = Invoke-LocalCheck $Client 'PATCH' $adminPath @{status='In Progress'} $Admin.Token $revision
    $detail = Invoke-LocalCheck $Client 'GET' ($authorPath+'?page=1&limit=50') $null $Author.Token
    $valid = $changed.Status -eq 200 -and (Test-Keys $changed.Data @('ticket')) -and (Test-Ticket $changed.Data.ticket $true) -and
        $changed.Data.ticket._id -ceq $script:CreatedTicketId -and $changed.Data.ticket.status -ceq 'In Progress' -and
        (Test-Detail $detail $false) -and $detail.Data.ticket.status -ceq 'In Progress'
    Report-Check 'Valid smoke ticket status update' $changed.Status $valid
    if ($queue.Valid) {
        $foreignId = $queue.Items | Where-Object {$_.author -is [PSCustomObject] -and $_.author.author_id -cne 'AUTH001' -and $_._id -cne $script:CreatedTicketId} | Select-Object -First 1 -ExpandProperty _id
        if ($foreignId) {
            $foreign = Invoke-LocalCheck $Client 'GET' ('/api/me/tickets/'+$foreignId) $null $Author.Token
            Report-Check 'Cross-author ticket hidden' $foreign.Status ($foreign.Status -eq 404 -and (Test-Keys $foreign.Data @('error')) -and $foreign.Data.error -ceq 'Ticket not found')
        }
    }
}

$client=$null; $handler=$null; $admin=$null; $author=$null; $invalid=$null
try {
    $port=5000
    if ($args.Count -ne 0) {
        if ($args.Count -ne 2 -or $args[0] -cne '-Port' -or -not [int]::TryParse([string]$args[1],[ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw 'Invalid arguments' }
    }
    if ($Host.Name -ne 'ConsoleHost' -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { throw 'Interactive console required' }
    Add-Type -AssemblyName System.Net.Http
    $handler=[System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect=$false; $handler.UseProxy=$false; $handler.UseCookies=$false; $handler.UseDefaultCredentials=$false
    $client=[System.Net.Http.HttpClient]::new($handler); $client.BaseAddress=[Uri]('http://127.0.0.1:'+$port)
    $client.Timeout=[TimeSpan]::FromSeconds(15); $client.MaxResponseContentBufferSize=4194304
    $admin=Read-Login $client 'admin'; $author=Read-Login $client 'author'
    Invoke-TicketWorkflow $client $admin $author
    if ($author) {
        $invalid=Invoke-LocalCheck $client 'GET' '/api/me/tickets/not-a-ticket-id' $null $author.Token
        Report-Check 'Invalid ticket ID rejected' $invalid.Status ($invalid.Status -eq 400 -and (Test-Keys $invalid.Data @('error')) -and $invalid.Data.error -ceq 'Invalid ticket request')
    }
}
catch { Write-TestResult 'Local smoke test setup or execution' 0 'FAIL' }
finally {
    foreach ($name in $script:Checks) { if (-not $script:Reported.Contains($name)) { Write-TestResult $name 0 'NOT PERFORMED' } }
    if ($script:CreateAttempted) {
        if ($script:CreateStatus -eq 201) { Write-TestResult 'Smoke creation acknowledged; records retained for manual cleanup' 201 'PASS' }
        else { Write-TestResult 'Creation attempted; inspect smoke records before retrying' $script:CreateStatus 'FAIL' }
    }
    if ($null -ne $client) { $client.Dispose() }; if ($null -ne $handler) { $handler.Dispose() }
    $admin=$null; $author=$null; $invalid=$null
    $script:CreatedTicketId=$null; $script:Subject=$null; $script:Reply=$null; $script:Note=$null
}
if ($script:Failed) { exit 1 }
if ($script:Incomplete) { exit 2 }
exit 0
