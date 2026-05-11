<?php
// ═══════════════════════════════════════════════════════════════
//   SYNC ASSESSMENT — Config
//   Isi dengan credential Supabase kamu
// ═══════════════════════════════════════════════════════════════

// Supabase > Settings > API > Project URL + service_role key
define('SUPABASE_URL', 'https://YOURPROJECT.supabase.co');
define('SUPABASE_KEY', 'YOUR_SERVICE_ROLE_KEY');  // service_role, BUKAN anon!

// Coach login (ubah password setelah deploy!)
$COACHES = [
    'jet' => ['id' => 1, 'name' => 'Jet', 'password' => 'jet123'],
    'lex' => ['id' => 2, 'name' => 'Lex', 'password' => 'lex123'],
];
