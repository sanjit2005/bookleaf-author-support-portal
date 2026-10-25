# Local, manually invoked only. PowerShell 5.1+; optional argument: -Port NUMBER.
# No database clients, environment files, logout, server lifecycle or record writes.
$ErrorActionPreference = 'Stop'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$script:Failed = $false
$script:Incomplete = $false
$script:BookKeys = @('book_id', 'title', 'isbn', 'genre', 'publication_date', 'status', 'mrp',
    'author_royalty_per_copy', 'total_copies_sold', 'total_royalty_earned', 'royalty_paid',
    'royalty_pending', 'last_royalty_payout_date', 'print_partner', 'available_on')

function Write-TestResult {
    param([string]$Name, [int]$Status, [ValidateSet('PASS', 'FAIL', 'NOT PERFORMED')][string]$Result)
    $statusText = if ($Status -gt 0) { [string]$Status } else { '--' }
    [Console]::WriteLine(('{0} | HTTP {1} | {2}' -f $Name, $statusText, $Result))
    if ($Result -ceq 'FAIL') { $script:Failed = $true }
    if ($Result -ceq 'NOT PERFORMED') { $script:Incomplete = $true }
}

function Convert-SecretInMemory {
    param([Security.SecureString]$Value)
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
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

function Test-Integer {
    param($Value, [long]$Minimum = 0)
    return ($Value -is [int] -or $Value -is [long]) -and $Value -ge $Minimum -and $Value -le 9007199254740991
}

function Test-Book {
    param($Book, [bool]$Admin)
    $keys = $script:BookKeys
    if ($Admin) { $keys = $keys + 'author' }
    if (-not (Test-ExactKeys $Book $keys)) { return $false }
    if ($Book.book_id -isnot [string] -or $Book.book_id.Length -gt 200 -or $Book.book_id -cnotmatch '^BK\d+$') { return $false }
    foreach ($field in @('title', 'isbn', 'genre', 'status')) {
        if ($Book.$field -isnot [string] -or -not $Book.$field) { return $false }
    }
    foreach ($field in @('publication_date', 'last_royalty_payout_date')) {
        if ($null -ne $Book.$field -and ($Book.$field -isnot [string] -or $Book.$field -cnotmatch '^\d{4}-\d{2}-\d{2}$')) { return $false }
    }
    foreach ($field in @('mrp', 'author_royalty_per_copy', 'total_royalty_earned', 'royalty_paid', 'royalty_pending')) {
        if ($null -eq $Book.$field -and @('mrp', 'author_royalty_per_copy') -ccontains $field) { continue }
        if ($Book.$field -isnot [string] -or $Book.$field -cnotmatch '^\d+(\.\d+)?([Ee][+-]?\d+)?$') { return $false }
    }
    if (-not (Test-Integer $Book.total_copies_sold)) { return $false }
    if ($null -ne $Book.print_partner -and $Book.print_partner -isnot [string]) { return $false }
    if ($Book.available_on -isnot [array]) { return $false }
    foreach ($platform in $Book.available_on) { if ($platform -isnot [string]) { return $false } }
    if ($Admin) {
        if (-not (Test-ExactKeys $Book.author @('_id', 'author_id', 'name'))) { return $false }
        if ($Book.author._id -isnot [string] -or $Book.author._id -cnotmatch '^[a-f0-9]{24}$' -or
            $Book.author.author_id -isnot [string] -or $Book.author.author_id -cnotmatch '^AUTH\d+$' -or
            $Book.author.name -isnot [string]) { return $false }
    }
    return $true
}

function Invoke-LocalCheck {
    param($Client, [string]$Method, [string]$Path, $Payload, [string]$Bearer)
    $request = $null; $response = $null; $json = $null; $body = $null; $data = $null; $status = 0
    try {
        if ($Client.BaseAddress.Scheme -cne 'http' -or $Client.BaseAddress.Host -cne '127.0.0.1') { throw 'Invalid local target' }
        # Only login and exact read-only Books API paths may be requested.
        $allowed = ($Method -ceq 'POST' -and $Path -ceq '/api/auth/login') -or
            ($Method -ceq 'GET' -and ($Path -cmatch '^/api/(me|admin)/books\?page=[1-9]\d*&limit=50$' -or
                $Path -ceq '/api/admin/books' -or $Path -cmatch '^/api/me/books/BK\d+$' -or
                $Path -ceq '/api/me/books/not-a-book-id'))
        if (-not $allowed) { throw 'Invalid check' }
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Path)
        if ($null -ne $Payload) {
            $json = $Payload | ConvertTo-Json -Compress
            $request.Content = [System.Net.Http.StringContent]::new($json, [Text.Encoding]::UTF8, 'application/json')
        }
        if ($Bearer) { $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Bearer) }
        $response = $Client.SendAsync($request).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $data = $body | ConvertFrom-Json
        return [PSCustomObject]@{ Status = $status; Data = $data }
    }
    catch { return [PSCustomObject]@{ Status = $status; Data = $null } }
    finally {
        # Never display exception text, request/response bodies, or authorization headers.
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $request) { $request.Dispose() }
        $Payload = $null; $Bearer = $null; $json = $null; $body = $null; $data = $null
    }
}

function Read-Login {
    param($Client, [ValidateSet('admin', 'author')][string]$Role)
    $emailSecure = $null; $passwordSecure = $null; $email = $null; $password = $null; $login = $null
    try {
        $emailSecure = Read-Host ($Role + ' email (hidden)') -AsSecureString
        $passwordSecure = Read-Host ($Role + ' password (hidden)') -AsSecureString
        $email = (Convert-SecretInMemory $emailSecure).Trim().ToLowerInvariant()
        $password = Convert-SecretInMemory $passwordSecure
        if (-not $email -or -not $password -or [Text.Encoding]::UTF8.GetByteCount($password) -gt 72 -or $password.Contains([string][char]0)) { throw 'Invalid interactive input' }
        $login = Invoke-LocalCheck $Client 'POST' '/api/auth/login' @{ email = $email; password = $password } $null
        $valid = $login.Status -eq 200 -and (Test-ExactKeys $login.Data @('accessToken', 'tokenType', 'expiresIn', 'user')) -and
            (Test-ExactKeys $login.Data.user @('_id', 'email', 'role')) -and
            $login.Data.user._id -is [string] -and $login.Data.user._id -cmatch '^[a-f0-9]{24}$' -and
            $login.Data.user.email -is [string] -and $login.Data.user.email -ceq $email -and
            $login.Data.user.role -is [string] -and $login.Data.user.role -ceq $Role -and
            $login.Data.accessToken -is [string] -and $login.Data.accessToken -cmatch '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' -and
            $login.Data.tokenType -ceq 'Bearer' -and (Test-Integer $login.Data.expiresIn 1) -and $login.Data.expiresIn -eq 900
        $result = if ($valid) { 'PASS' } else { 'FAIL' }
        Write-TestResult ($Role + ' login and safe user DTO') $login.Status $result
        if ($valid) { return $login.Data.accessToken }
        return $null
    }
    finally {
        if ($null -ne $emailSecure) { $emailSecure.Dispose() }
        if ($null -ne $passwordSecure) { $passwordSecure.Dispose() }
        $email = $null; $password = $null; $login = $null
    }
}

function Read-Books {
    param($Client, [string]$Bearer, [bool]$Admin)
    $path = if ($Admin) { '/api/admin/books' } else { '/api/me/books' }
    $books = [System.Collections.Generic.List[object]]::new()
    $ids = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $total = -1; $pages = 1; $status = 0
    # Bound the manual run to 100 pages / 5000 books. Never claim a partial list is complete.
    for ($page = 1; $page -le $pages; $page++) {
        $response = Invoke-LocalCheck $Client 'GET' ($path + '?page=' + $page + '&limit=50') $null $Bearer
        $status = $response.Status
        if ($status -ne 200 -or -not (Test-ExactKeys $response.Data @('books', 'pagination')) -or
            $response.Data.books -isnot [array] -or -not (Test-ExactKeys $response.Data.pagination @('page', 'limit', 'total', 'totalPages'))) { break }
        $paging = $response.Data.pagination
        if (-not (Test-Integer $paging.page 1) -or $paging.page -ne $page -or
            -not (Test-Integer $paging.limit 1) -or $paging.limit -ne 50 -or
            -not (Test-Integer $paging.total) -or -not (Test-Integer $paging.totalPages) -or
            $paging.totalPages -ne [Math]::Ceiling($paging.total / 50.0) -or $paging.totalPages -gt 100) { break }
        if ($total -eq -1) { $total = $paging.total; $pages = [Math]::Max(1, $paging.totalPages) }
        if ($paging.total -ne $total -or $response.Data.books.Count -ne [Math]::Min(50, [Math]::Max(0, $total - (($page - 1) * 50)))) { break }
        $valid = $true
        foreach ($book in $response.Data.books) {
            if (-not (Test-Book $book $Admin) -or -not $ids.Add($book.book_id)) { $valid = $false; break }
            $books.Add($book)
        }
        if (-not $valid) { break }
        if ($page -eq $pages -and $books.Count -eq $total) {
            return [PSCustomObject]@{ Status = $status; Valid = $true; Books = $books.ToArray() }
        }
    }
    return [PSCustomObject]@{ Status = $status; Valid = $false; Books = @() }
}

$client = $null; $handler = $null; $adminToken = $null; $authorToken = $null
$adminBooks = $null; $authorBooks = $null; $detail = $null; $foreign = $null; $invalid = $null; $denied = $null
try {
    $port = 5000
    if ($args.Count -ne 0) {
        if ($args.Count -ne 2 -or $args[0] -cne '-Port' -or
            -not [int]::TryParse([string]$args[1], [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw 'Invalid arguments' }
    }
    if ($Host.Name -ne 'ConsoleHost' -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { throw 'Interactive console required' }
    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false; $handler.UseProxy = $false
    $handler.UseCookies = $false; $handler.UseDefaultCredentials = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.BaseAddress = [Uri]('http://127.0.0.1:' + $port)
    $client.Timeout = [TimeSpan]::FromSeconds(10)
    $client.MaxResponseContentBufferSize = 1048576

    $adminToken = Read-Login $client 'admin'
    $authorToken = Read-Login $client 'author'
    if ($adminToken) {
        $adminBooks = Read-Books $client $adminToken $true
        $result = if ($adminBooks.Valid) { 'PASS' } else { 'FAIL' }
        Write-TestResult 'Admin paginated books and safe DTOs' $adminBooks.Status $result
    }
    else { Write-TestResult 'Admin paginated books and safe DTOs' 0 'NOT PERFORMED' }
    if ($adminBooks -and $adminBooks.Valid) {
        $authorIds = @($adminBooks.Books | ForEach-Object { $_.author.author_id } | Sort-Object -Unique)
        $result = if ($authorIds.Count -gt 1) { 'PASS' } else { 'NOT PERFORMED' }
        Write-TestResult 'Admin books across authors' $adminBooks.Status $result
    }
    else { Write-TestResult 'Admin books across authors' 0 'NOT PERFORMED' }
    if ($authorToken) {
        $authorBooks = Read-Books $client $authorToken $false
        $result = if ($authorBooks.Valid) { 'PASS' } else { 'FAIL' }
        Write-TestResult 'Author paginated books and safe DTOs' $authorBooks.Status $result
    }
    else { Write-TestResult 'Author paginated books and safe DTOs' 0 'NOT PERFORMED' }

    $expectedIds = @(); $ownedBookId = $null; $foreignBookId = $null
    if ($adminBooks -and $adminBooks.Valid) {
        $expectedIds = @($adminBooks.Books | Where-Object { $_.author.author_id -ceq 'AUTH001' } | ForEach-Object { $_.book_id })
        $foreignBookId = $adminBooks.Books | Where-Object { $_.author.author_id -cne 'AUTH001' } | Select-Object -First 1 -ExpandProperty book_id
    }
    if ($authorBooks -and $authorBooks.Valid -and $expectedIds.Count -gt 0) {
        $actualIds = @($authorBooks.Books | ForEach-Object { $_.book_id })
        $matches = $actualIds.Count -eq $expectedIds.Count
        foreach ($bookId in $actualIds) { if ($expectedIds -cnotcontains $bookId) { $matches = $false } }
        $result = if ($matches) { 'PASS' } else { 'FAIL' }
        Write-TestResult 'Author list matches only AUTH001 books' $authorBooks.Status $result
        $ownedBookId = $authorBooks.Books | Where-Object { $expectedIds -ccontains $_.book_id } | Select-Object -First 1 -ExpandProperty book_id
    }
    else { Write-TestResult 'Author list matches only AUTH001 books' 0 'NOT PERFORMED' }
    if ($authorToken -and $ownedBookId) {
        $detail = Invoke-LocalCheck $client 'GET' ('/api/me/books/' + $ownedBookId) $null $authorToken
        $valid = $detail.Status -eq 200 -and (Test-ExactKeys $detail.Data @('book')) -and
            (Test-Book $detail.Data.book $false) -and $detail.Data.book.book_id -ceq $ownedBookId
        $result = if ($valid) { 'PASS' } else { 'FAIL' }
        Write-TestResult 'Owned book detail and safe DTO' $detail.Status $result
    }
    else { Write-TestResult 'Owned book detail and safe DTO' 0 'NOT PERFORMED' }
    if ($authorToken -and $foreignBookId) {
        $foreign = Invoke-LocalCheck $client 'GET' ('/api/me/books/' + $foreignBookId) $null $authorToken
        $valid = $foreign.Status -eq 404 -and (Test-ExactKeys $foreign.Data @('error')) -and $foreign.Data.error -ceq 'Book not found'
        $result = if ($valid) { 'PASS' } else { 'FAIL' }
        Write-TestResult 'Foreign book detail is hidden' $foreign.Status $result
    }
    else { Write-TestResult 'Foreign book detail is hidden' 0 'NOT PERFORMED' }
    if ($authorToken) {
        $invalid = Invoke-LocalCheck $client 'GET' '/api/me/books/not-a-book-id' $null $authorToken
        $valid = $invalid.Status -eq 400 -and (Test-ExactKeys $invalid.Data @('error')) -and $invalid.Data.error -ceq 'Invalid book ID'
        $result = if ($valid) { 'PASS' } else { 'FAIL' }
        Write-TestResult 'Malformed book ID rejected safely' $invalid.Status $result
        $denied = Invoke-LocalCheck $client 'GET' '/api/admin/books' $null $authorToken
        $valid = $denied.Status -eq 403 -and (Test-ExactKeys $denied.Data @('error')) -and $denied.Data.error -ceq 'Forbidden'
        $result = if ($valid) { 'PASS' } else { 'FAIL' }
        Write-TestResult 'Author denied admin books' $denied.Status $result
    }
    else {
        Write-TestResult 'Malformed book ID rejected safely' 0 'NOT PERFORMED'
        Write-TestResult 'Author denied admin books' 0 'NOT PERFORMED'
    }
}
catch { Write-TestResult 'Local smoke test setup or execution' 0 'FAIL' }
finally {
    if ($null -ne $client) { $client.Dispose() }
    if ($null -ne $handler) { $handler.Dispose() }
    $adminToken = $null; $authorToken = $null; $adminBooks = $null; $authorBooks = $null
    $detail = $null; $foreign = $null; $invalid = $null; $denied = $null
    $expectedIds = $null; $actualIds = $null; $authorIds = $null; $ownedBookId = $null; $foreignBookId = $null; $bookId = $null
}
if ($script:Failed) { exit 1 }
if ($script:Incomplete) { exit 2 }
exit 0
