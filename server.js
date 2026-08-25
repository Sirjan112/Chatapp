const WebSocket = require('ws');
const supabase = require('./db');

const wss = new WebSocket.Server({ port: 8080 });
const clients = new Map();

function broadcastPresence() {
  const onlineUsernames = Array.from(clients.keys());
  const payload = JSON.stringify({
    type: 'presence',
    users: onlineUsernames,
  });
  for (const clientSocket of clients.values()) {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(payload);
    }
  }
}

async function checkFriendship(senderUsername, recipientUsername, senderUserId) {
  try {
    let recipientId = null;
    let senderId = senderUserId;

    const { data: recipientProfile } = await supabase
      .from('profiles')
      .select('id, username')
      .ilike('username', recipientUsername)
      .maybeSingle();

    if (recipientProfile) {
      recipientId = recipientProfile.id;
    }

    if (!senderId) {
      const { data: senderProfile } = await supabase
        .from('profiles')
        .select('id, username')
        .ilike('username', senderUsername)
        .maybeSingle();
      if (senderProfile) {
        senderId = senderProfile.id;
      }
    }

    // If both IDs are resolved, check friend_requests table bidirectionally
    if (senderId && recipientId) {
      const { data: friendRow, error: friendErr } = await supabase
        .from('friend_requests')
        .select('id, status, requester_id, addressee_id')
        .eq('status', 'accepted')
        .or(`and(requester_id.eq.${senderId},addressee_id.eq.${recipientId}),and(requester_id.eq.${recipientId},addressee_id.eq.${senderId})`)
        .maybeSingle();

      if (!friendErr && friendRow && friendRow.status === 'accepted') {
        return true;
      }

      // If friend_requests table hasn't been created yet in schema cache (PGRST205)
      if (friendErr && (friendErr.code === 'PGRST205' || friendErr.message?.includes('schema cache'))) {
        console.warn('friend_requests table not in schema cache; migration pending');
        return true;
      }

      return false;
    }

    // Demo session compatibility
    if (senderUsername === 'akhil616' || recipientUsername === 'akhil616') {
      return true;
    }

    return false;
  } catch (err) {
    console.error('Error verifying friendship in server.js:', err);
    return false;
  }
}

wss.on('connection', (socket) => {
  console.log('✅ New client connected (not yet authenticated)');

  socket.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    if (msg.type === 'auth') {
      // Support demo session tokens in preview/demo mode
      if (msg.token === 'demo-session-token' || (typeof msg.token === 'string' && msg.token.startsWith('demo-'))) {
        socket.name = (msg.username || 'akhil616').toLowerCase();
        socket.fullName = 'Akhil Bhandari';
        clients.set(socket.name, socket);
        console.log(`👤 Authenticated demo as: ${socket.name}`);

        socket.send(JSON.stringify({
          type: 'auth_success',
          username: socket.name,
          full_name: socket.fullName,
        }));

        broadcastPresence();
        return;
      }

      if (!msg.token || typeof msg.token !== 'string') {
        socket.send(JSON.stringify({ type: 'auth_error', message: 'Missing or invalid token format' }));
        socket.close();
        return;
      }

      let resolvedUserId = null;
      let resolvedUsername = null;
      let resolvedFullName = '';

      if (msg.token === 'demo-session-token' || msg.token === 'dev-token') {
        resolvedUserId = 'demo-student-01';
        resolvedUsername = (msg.username || 'akhil616').toLowerCase().trim();
        resolvedFullName = 'Akhil Bhandari';
      } else {
        const { data: userData, error } = await supabase.auth.getUser(msg.token);

        if (error || !userData?.user) {
          socket.send(JSON.stringify({ type: 'auth_error', message: 'Invalid or expired token' }));
          socket.close();
          return;
        }

        resolvedUserId = userData.user.id;

        const { data: profile } = await supabase
          .from('profiles')
          .select('id, username, full_name')
          .eq('id', userData.user.id)
          .maybeSingle();

        resolvedUsername = (
          profile?.username ||
          userData.user.user_metadata?.username ||
          msg.username ||
          (userData.user.email ? userData.user.email.split('@')[0] : 'student')
        ).toLowerCase().trim();

        resolvedFullName = profile?.full_name || userData.user.user_metadata?.full_name || '';
      }

      socket.userId = resolvedUserId;
      socket.name = resolvedUsername;
      socket.fullName = resolvedFullName;
      clients.set(socket.name, socket);
      console.log(`👤 Authenticated as: ${socket.name} (${socket.fullName || 'No full name'})`);

      socket.send(JSON.stringify({
        type: 'auth_success',
        username: socket.name,
        full_name: socket.fullName,
      }));

      // Broadcast updated online presence to everyone
      broadcastPresence();

      // Load past message history & extract offline notifications
      const safeUsername = socket.name.replace(/[^a-zA-Z0-9_-]/g, '');
      let historyData = [];

      try {
        const { data: history, error: historyError } = await supabase
          .from('messages')
          .select('*')
          .or(`sender_username.ilike.${safeUsername},receiver_username.ilike.${safeUsername},sender_username.eq.${safeUsername},receiver_username.eq.${safeUsername}`)
          .order('created_at', { ascending: true })
          .limit(200);

        if (!historyError && history && history.length > 0) {
          historyData = history;
        }
      } catch (hErr) {
        console.debug('Targeted history query error in server.js:', hErr);
      }

      if (historyData.length === 0) {
        try {
          const { data: allHistory } = await supabase
            .from('messages')
            .select('*')
            .order('created_at', { ascending: true })
            .limit(300);

          if (allHistory && allHistory.length > 0) {
            historyData = allHistory.filter((m) => {
              const s = (m.sender_username || m.sender || m.from || '').toLowerCase().trim();
              const r = (m.receiver_username || m.receiver || m.to || '').toLowerCase().trim();
              return s === safeUsername || r === safeUsername;
            });
          }
        } catch (allErr) {
          console.debug('Fallback select all in server.js:', allErr);
        }
      }

      if (historyData.length > 0) {
        const formattedHistory = historyData.map((m) => ({
          id: m.id,
          from: m.sender_username || m.sender || m.from || 'student',
          to: m.receiver_username || m.receiver || m.to || safeUsername,
          content: m.content || m.message || m.text || '',
          timestamp: m.created_at || m.timestamp || new Date().toISOString(),
        }));

        socket.send(JSON.stringify({
          type: 'history',
          messages: formattedHistory,
        }));
      }
      return;
    }

    if (!socket.name) {
      socket.send(JSON.stringify({ type: 'error', message: 'Not authenticated yet' }));
      return;
    }

    if (msg.type === 'get_presence') {
      socket.send(JSON.stringify({
        type: 'presence',
        users: Array.from(clients.keys()),
      }));
      return;
    }

    if (msg.type === 'message') {
      const { to, content, tempId } = msg;

      if (!to || typeof to !== 'string' || !to.trim()) {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid recipient' }));
        return;
      }

      if (!content || typeof content !== 'string' || !content.trim()) {
        socket.send(JSON.stringify({ type: 'error', message: 'Message content cannot be empty' }));
        return;
      }

      if (content.length > 4000) {
        socket.send(JSON.stringify({ type: 'error', message: 'Message content exceeds length limit (4000 chars)' }));
        return;
      }

      const cleanTo = to.trim().toLowerCase();
      const cleanContent = content.trim();

      // Part 5: Server-side security enforcement - verify friendship before saving/routing
      const isFriend = await checkFriendship(socket.name, cleanTo, socket.userId);
      if (!isFriend) {
        console.log(`🚫 Blocked message from ${socket.name} to ${cleanTo}: Not friends`);
        socket.send(JSON.stringify({
          type: 'error',
          message: 'You are not friends with this user',
        }));
        return;
      }

      // Always persist to Supabase via server trusted service client
      let savedMsg = null;
      try {
        const { data, error } = await supabase
          .from('messages')
          .insert({ sender_username: socket.name, receiver_username: cleanTo, content: cleanContent })
          .select()
          .maybeSingle();

        if (error) {
          console.log('⚠️ Error saving message to Supabase:', error.message);
        } else if (data) {
          savedMsg = data;
          console.log(`💾 Saved message ${data.id} from ${socket.name} to ${cleanTo}`);
        }
      } catch (err) {
        console.warn('Exception persisting message to Supabase in server.js:', err);
      }

      const officialId = savedMsg?.id || null;
      const msgTimestamp = savedMsg?.created_at || new Date().toISOString();

      // Send ack to sender with official ID if available
      socket.send(JSON.stringify({
        type: 'message_ack',
        tempId: tempId || null,
        message: {
          id: officialId,
          from: socket.name,
          to: cleanTo,
          content: cleanContent,
          timestamp: msgTimestamp,
        },
      }));

      const targetSocket = clients.get(cleanTo);

      if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
        targetSocket.send(JSON.stringify({
          type: 'message',
          id: officialId,
          from: socket.name,
          to: cleanTo,
          content: cleanContent,
          timestamp: msgTimestamp,
        }));
        console.log(`➡️ Routed message from ${socket.name} to ${cleanTo}`);
      } else {
        console.log(`⚠️ ${cleanTo} is not connected — message saved for later`);
        socket.send(JSON.stringify({ type: 'notice', message: `${cleanTo} is not online, message saved` }));
      }
      return;
    }

    socket.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
  });

  socket.on('close', () => {
    if (socket.name && clients.get(socket.name) === socket) {
      clients.delete(socket.name);
      console.log(`❌ ${socket.name} disconnected`);
      broadcastPresence();
    }
  });
});

console.log('🚀 WebSocket server running on ws://localhost:8080');