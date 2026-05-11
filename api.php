<?php
session_start();
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

require_once 'config.php';

$action = $_GET['action'] ?? '';

// ─── Supabase REST helper ────────────────────────────────────────────────────
function sb(string $table, string $method = 'GET', mixed $data = null, array $filters = []): array {
    $url = SUPABASE_URL . '/rest/v1/' . $table;
    if ($filters) $url .= '?' . http_build_query($filters);

    $headers = [
        'Content-Type: application/json',
        'apikey: ' . SUPABASE_KEY,
        'Authorization: Bearer ' . SUPABASE_KEY,
        'Prefer: return=representation',
    ];

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => 15,
    ]);

    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        if ($data) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
    } elseif (in_array($method, ['PATCH', 'DELETE'])) {
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
        if ($data) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
    }

    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['code' => $code, 'data' => json_decode($body, true) ?? []];
}

// ─── Code generation ─────────────────────────────────────────────────────────
function initials(string $name): string {
    $letters = preg_replace('/[^a-zA-Z]/', '', $name);
    return strtoupper(str_pad(substr($letters, 0, 2), 2, 'X'));
}

function make_code(string $name, string $digits): string {
    return initials($name) . $digits;
}

function code_is_unique(string $code): bool {
    $r = sb('clients', 'GET', null, ['or' => "(code.eq.{$code},partner_code.eq.{$code})", 'select' => 'id']);
    return count($r['data']) === 0;
}

function generate_unique_codes(string $name, string $partnerName = ''): array {
    for ($i = 0; $i < 30; $i++) {
        $digits = str_pad(mt_rand(0, 999999), 6, '0', STR_PAD_LEFT);
        $code   = make_code($name, $digits);
        if (!code_is_unique($code)) continue;

        if ($partnerName) {
            $ini2 = initials($partnerName);
            // Avoid identical codes if both names share initials
            if ($ini2 === initials($name)) {
                $nameLetters = preg_replace('/[^a-zA-Z]/', '', $partnerName);
                $ini2 = strtoupper(str_pad(substr($nameLetters, 0, 1) . substr($nameLetters, -1), 2, 'X'));
            }
            $pCode = $ini2 . $digits;
            if (!code_is_unique($pCode)) continue;
            return ['digits' => $digits, 'code' => $code, 'partner_code' => $pCode];
        }
        return ['digits' => $digits, 'code' => $code];
    }
    return [];
}

// ─── Auth guard ──────────────────────────────────────────────────────────────
function require_coach(): void {
    if (empty($_SESSION['coach_id'])) {
        http_response_code(401);
        echo json_encode(['error' => 'Unauthorized']);
        exit;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//   ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════
switch ($action) {

// ── Client: verify code ──────────────────────────────────────────────────────
case 'verify':
    $code = strtoupper(trim($_GET['code'] ?? ''));
    if (strlen($code) !== 8) { echo json_encode(['mode' => 'invalid']); exit; }

    $r = sb('clients', 'GET', null, [
        'or'     => "(code.eq.{$code},partner_code.eq.{$code})",
        'select' => 'type',
        'limit'  => '1',
    ]);

    if (empty($r['data'])) {
        echo json_encode(['mode' => 'invalid']);
    } else {
        echo json_encode(['mode' => 'input', 'type' => $r['data'][0]['type']]);
    }
    break;

// ── Client: next session suggestion ─────────────────────────────────────────
case 'next_session':
    $code = strtoupper(trim($_GET['code'] ?? ''));
    if (strlen($code) !== 8) { echo json_encode(['next' => 1]); exit; }

    $sr = sb('sessions', 'GET', null, ['client_code' => "eq.{$code}", 'select' => 'session_number', 'order' => 'session_number.desc', 'limit' => '1']);
    $last = $sr['data'][0]['session_number'] ?? 0;
    echo json_encode(['next' => (int)$last + 1]);
    break;

// ── Client: submit session ───────────────────────────────────────────────────
case 'submit':
    $in = json_decode(file_get_contents('php://input'), true);
    if (!$in) { http_response_code(400); echo json_encode(['error' => 'Bad input']); exit; }

    $code    = strtoupper($in['kode'] ?? '');
    $sesiKe  = (int)($in['sesi'] ?? 1);
    $tipe    = $in['tipe'] ?? 'PRIBADI';

    $r = sb('clients', 'GET', null, [
        'or'     => "(code.eq.{$code},partner_code.eq.{$code})",
        'select' => 'id',
        'limit'  => '1',
    ]);
    if (empty($r['data'])) { http_response_code(403); echo json_encode(['error' => 'Invalid code']); exit; }

    // Prevent duplicate: check if same code+session+type already exists
    $dup = sb('sessions', 'GET', null, [
        'client_code'    => "eq.{$code}",
        'session_number' => "eq.{$sesiKe}",
        'type'           => "eq.{$tipe}",
        'select'         => 'id',
        'limit'          => '1',
    ]);
    if (!empty($dup['data'])) {
        echo json_encode(['success' => true, 'duplicate' => true]);
        exit;
    }

    $row = [
        'client_code'    => $code,
        'session_number' => $sesiKe,
        'type'           => $tipe,
        'date'           => $in['tanggal']        ?? date('Y-m-d'),
        'skor1'          => (float)($in['skor1']  ?? 0),
        'skor2'          => (float)($in['skor2']  ?? 0),
        'skor3'          => (float)($in['skor3']  ?? 0),
        'skor4'          => (float)($in['skor4']  ?? 0),
        'skor5'          => (float)($in['skor5']  ?? 0),
        'total'          => (float)($in['total']  ?? 0),
    ];

    $result = sb('sessions', 'POST', $row);
    echo json_encode(['success' => $result['code'] === 201]);
    break;

// ── Coach: login ─────────────────────────────────────────────────────────────
case 'login':
    $in       = json_decode(file_get_contents('php://input'), true);
    $username = strtolower(trim($in['username'] ?? ''));
    $password = $in['password'] ?? '';

    global $COACHES;
    if (isset($COACHES[$username]) && $COACHES[$username]['password'] === $password) {
        $_SESSION['coach_id']       = $COACHES[$username]['id'];
        $_SESSION['coach_name']     = $COACHES[$username]['name'];
        $_SESSION['coach_username'] = $username;
        echo json_encode(['success' => true, 'name' => $COACHES[$username]['name']]);
    } else {
        http_response_code(401);
        echo json_encode(['success' => false]);
    }
    break;

// ── Coach: logout ────────────────────────────────────────────────────────────
case 'logout':
    session_destroy();
    echo json_encode(['success' => true]);
    break;

// ── Coach: check session ─────────────────────────────────────────────────────
case 'me':
    if (empty($_SESSION['coach_id'])) {
        echo json_encode(['loggedIn' => false]);
    } else {
        echo json_encode([
            'loggedIn' => true,
            'name'     => $_SESSION['coach_name'],
            'username' => $_SESSION['coach_username'],
        ]);
    }
    break;

// ── Coach: list clients ──────────────────────────────────────────────────────
case 'clients':
    require_coach();

    $r       = sb('clients', 'GET', null, ['coach_id' => 'eq.' . $_SESSION['coach_id'], 'order' => 'created_at.desc']);
    $clients = $r['data'] ?? [];

    foreach ($clients as &$client) {
        $c  = $client['code'];
        $pc = $client['partner_code'];

        $filter = $pc
            ? ['or' => "(client_code.eq.{$c},client_code.eq.{$pc})", 'select' => 'session_number,date', 'order' => 'date.desc']
            : ['client_code' => "eq.{$c}", 'select' => 'session_number,date', 'order' => 'date.desc'];

        $sr = sb('sessions', 'GET', null, $filter);
        $sessions = $sr['data'] ?? [];
        $client['session_count']    = count($sessions);
        $client['last_session_date'] = $sessions[0]['date'] ?? null;
        $client['max_session']       = $sessions ? max(array_column($sessions, 'session_number')) : 0;
    }
    unset($client);

    echo json_encode($clients);
    break;

// ── Coach: create client ─────────────────────────────────────────────────────
case 'create_client':
    require_coach();

    $in   = json_decode(file_get_contents('php://input'), true);
    $type = $in['type'] ?? 'single';
    $name = trim($in['name'] ?? '');

    if (!$name) { http_response_code(400); echo json_encode(['error' => 'Name required']); exit; }

    $partnerName  = trim($in['partner_name']  ?? '');
    $partnerPhone = trim($in['partner_phone'] ?? '');

    if ($type === 'couple' && !$partnerName) {
        http_response_code(400); echo json_encode(['error' => 'Partner name required']); exit;
    }

    $codes = generate_unique_codes($name, $type === 'couple' ? $partnerName : '');
    if (!$codes) { http_response_code(500); echo json_encode(['error' => 'Could not generate unique code. Retry.']); exit; }

    $row = [
        'coach_id'     => $_SESSION['coach_id'],
        'name'         => $name,
        'phone'        => trim($in['phone'] ?? ''),
        'type'         => $type,
        'code'         => $codes['code'],
        'group_prefix' => $codes['digits'],
    ];

    if ($type === 'couple') {
        $row['partner_code']  = $codes['partner_code'];
        $row['partner_name']  = $partnerName;
        $row['partner_phone'] = $partnerPhone;
    }

    $result = sb('clients', 'POST', $row);

    if ($result['code'] === 201) {
        echo json_encode(['success' => true, 'client' => $result['data'][0] ?? $row]);
    } else {
        http_response_code(500);
        echo json_encode(['error' => 'Failed to create', 'detail' => $result['data']]);
    }
    break;

// ── Coach: delete client ─────────────────────────────────────────────────────
case 'delete_client':
    require_coach();

    $in  = json_decode(file_get_contents('php://input'), true);
    $cid = (int)($in['id'] ?? 0);

    $r = sb('clients', 'GET', null, ['id' => "eq.{$cid}", 'coach_id' => 'eq.' . $_SESSION['coach_id'], 'select' => 'id,code,partner_code']);
    if (empty($r['data'])) { http_response_code(403); echo json_encode(['error' => 'Forbidden']); exit; }

    $cl = $r['data'][0];
    sb('sessions', 'DELETE', null, ['client_code' => 'eq.' . $cl['code']]);
    if ($cl['partner_code']) sb('sessions', 'DELETE', null, ['client_code' => 'eq.' . $cl['partner_code']]);
    sb('clients', 'DELETE', null, ['id' => "eq.{$cid}"]);

    echo json_encode(['success' => true]);
    break;

// ── Coach: get client session data ───────────────────────────────────────────
case 'client_data':
    require_coach();

    $cid = (int)($_GET['id'] ?? 0);
    $r   = sb('clients', 'GET', null, ['id' => "eq.{$cid}", 'coach_id' => 'eq.' . $_SESSION['coach_id']]);

    if (empty($r['data'])) { http_response_code(403); echo json_encode(['error' => 'Forbidden']); exit; }

    $client = $r['data'][0];
    $c      = $client['code'];
    $pc     = $client['partner_code'];

    $filter = $pc
        ? ['or' => "(client_code.eq.{$c},client_code.eq.{$pc})", 'order' => 'session_number.asc,created_at.asc']
        : ['client_code' => "eq.{$c}", 'order' => 'session_number.asc,created_at.asc'];

    $sr       = sb('sessions', 'GET', null, $filter);
    $rawSessions = $sr['data'] ?? [];

    // Map to legacy chart format
    $sessions = array_map(fn($s) => [
        'kode'    => $s['client_code'],
        'tipe'    => $s['type'],
        'sesi'    => $s['session_number'],
        'tanggal' => $s['date'],
        'skor1'   => $s['skor1'],
        'skor2'   => $s['skor2'],
        'skor3'   => $s['skor3'],
        'skor4'   => $s['skor4'],
        'skor5'   => $s['skor5'],
        'total'   => $s['total'],
    ], $rawSessions);

    echo json_encode(['success' => true, 'client' => $client, 'sessions' => $sessions]);
    break;

default:
    http_response_code(404);
    echo json_encode(['error' => 'Unknown action']);
}
