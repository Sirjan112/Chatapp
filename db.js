// This client is SERVER-ONLY. It uses the service role key, which bypasses
// Row Level Security entirely -- that's intentional: our server already
// verifies every user's identity itself (via their JWT) before touching the
// database, so it acts as the trusted gatekeeper instead of relying on RLS.
// This key must NEVER be sent to a client or committed to a public repo.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const DEFAULT_SUPABASE_URL = 'https://uhulsyidhzatyuxeiejz.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_YYi7fmR59z8L6dUl3VonBQ_9X4E3ckS';

const supabaseUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;

const supabase = createClient(
  supabaseUrl,
  supabaseKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    // AL2023's Node 20 has no global WebSocket, which @supabase/realtime-js needs
    // just to construct a RealtimeClient (even though this server never subscribes
    // to realtime channels). Without this, createClient() throws synchronously and
    // crash-loops the whole process before it ever binds port 8080.
    realtime: {
      transport: WebSocket,
    },
  }
);

module.exports = supabase;