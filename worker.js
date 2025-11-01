// =====================================================
// VLESS VPN - Advanced Implementation
// SNI Routing + Bug Hosting Support
// Deploy langsung di Cloudflare Workers Dashboard
// =====================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // API: Get all accounts
    if (url.pathname === '/api/accounts') {
      return handleGetAccounts(env, corsHeaders);
    }

    // API: Create new account
    if (url.pathname === '/api/create') {
      return handleCreateAccount(request, env, corsHeaders);
    }

    // API: Delete account
    if (url.pathname === '/api/delete') {
      return handleDeleteAccount(request, env, corsHeaders);
    }

    // WebSocket VLESS Protocol
    const upgrade = request.headers.get('Upgrade');
    if (upgrade === 'websocket') {
      return handleVLESS(request, env);
    }

    // Serve Web Interface
    return new Response(getHTML(), {
      headers: { 'Content-Type': 'text/html', ...corsHeaders }
    });
  }
};

// =====================================================
// API HANDLERS
// =====================================================

async function handleGetAccounts(env, corsHeaders) {
  try {
    if (!env.VLESS_KV) {
      return jsonResponse({ accounts: [] }, corsHeaders);
    }

    const list = await env.VLESS_KV.list();
    const accounts = [];
    
    for (const key of list.keys) {
      const data = await env.VLESS_KV.get(key.name);
      if (data) accounts.push(JSON.parse(data));
    }

    return jsonResponse({ accounts }, corsHeaders);
  } catch (error) {
    console.error('Get accounts error:', error);
    return jsonResponse({ accounts: [], error: error.message }, corsHeaders);
  }
}

async function handleCreateAccount(request, env, corsHeaders) {
  try {
    const data = await request.json();
    const account = {
      uuid: data.uuid,
      server: data.server,
      port: data.port,
      path: data.path,
      wsHost: data.wsHost,
      sni: data.sni,
      security: data.security || 'tls',
      created: new Date().toISOString()
    };

    if (env.VLESS_KV) {
      await env.VLESS_KV.put(account.uuid, JSON.stringify(account));
    }

    return jsonResponse({ success: true, account }, corsHeaders);
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, corsHeaders, 500);
  }
}

async function handleDeleteAccount(request, env, corsHeaders) {
  try {
    const { uuid } = await request.json();
    if (env.VLESS_KV) {
      await env.VLESS_KV.delete(uuid);
    }
    return jsonResponse({ success: true }, corsHeaders);
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, corsHeaders, 500);
  }
}

function jsonResponse(data, headers, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

// =====================================================
// VLESS PROTOCOL - BIDIRECTIONAL PROXY
// =====================================================

async function handleVLESS(request, env) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  
  server.accept();
  
  // Handle VLESS connection
  vlessHandler(server, env).catch(err => {
    console.error('VLESS error:', err);
    safeClose(server, 1011, err.message);
  });

  return new Response(null, {
    status: 101,
    webSocket: client
  });
}

async function vlessHandler(ws, env) {
  let remote = null;
  let headerParsed = false;
  let remoteReader = null;

  // Client -> Server (Upload direction)
  ws.addEventListener('message', async (event) => {
    try {
      const data = event.data;

      if (!headerParsed) {
        // Parse VLESS header from first packet
        const buffer = new Uint8Array(await data.arrayBuffer());
        const parseResult = parseVLESSHeader(buffer, env);
        
        if (!parseResult.valid) {
          console.error('Invalid VLESS header:', parseResult.error);
          safeClose(ws, 1008, parseResult.error);
          return;
        }

        headerParsed = true;
        const { address, port, payload } = parseResult;
        
        console.log(`[VLESS] Connecting to ${address}:${port}`);

        // Connect to target server
        try {
          remote = connect({ hostname: address, port: port });

          // Start Server -> Client (Download direction)
          remoteToWebSocket(remote, ws, remoteReader);

          // Send initial payload if exists
          if (payload && payload.byteLength > 0) {
            const writer = remote.writable.getWriter();
            await writer.write(payload);
            writer.releaseLock();
            console.log(`[VLESS] Sent initial payload: ${payload.byteLength} bytes`);
          }

        } catch (error) {
          console.error('[VLESS] Connection failed:', error);
          safeClose(ws, 1011, `Connection failed: ${error.message}`);
          return;
        }

      } else {
        // Forward data to remote server
        if (remote && remote.writable) {
          const writer = remote.writable.getWriter();
          const buffer = await data.arrayBuffer();
          await writer.write(new Uint8Array(buffer));
          writer.releaseLock();
          console.log(`[UP] Client -> Remote: ${buffer.byteLength} bytes`);
        }
      }
    } catch (error) {
      console.error('[VLESS] Message error:', error);
      safeClose(ws, 1011, error.message);
    }
  });

  ws.addEventListener('close', () => {
    console.log('[VLESS] WebSocket closed');
    if (remote) {
      try {
        remote.close();
      } catch (e) {}
    }
  });

  ws.addEventListener('error', (err) => {
    console.error('[VLESS] WebSocket error:', err);
  });
}

// Server -> Client (Download direction)
async function remoteToWebSocket(remote, ws, readerRef) {
  try {
    const reader = remote.readable.getReader();
    readerRef = reader;

    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        console.log('[VLESS] Remote stream ended');
        break;
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(value);
        console.log(`[DOWN] Remote -> Client: ${value.byteLength} bytes`);
      } else {
        console.log('[VLESS] WebSocket closed, stopping read');
        break;
      }
    }
  } catch (error) {
    console.error('[VLESS] Remote read error:', error);
  } finally {
    safeClose(ws);
  }
}

// Parse VLESS Protocol Header
function parseVLESSHeader(buffer, env) {
  try {
    if (buffer.byteLength < 24) {
      return { valid: false, error: 'Buffer too short' };
    }

    let offset = 0;

    // Version
    const version = buffer[offset++];
    if (version !== 0) {
      return { valid: false, error: `Invalid version: ${version}` };
    }

    // UUID (16 bytes)
    const uuidBytes = buffer.slice(offset, offset + 16);
    const uuid = bytesToUUID(uuidBytes);
    offset += 16;

    // Validate UUID
    const isValid = env.VLESS_KV ? validateUUID(uuid, env) : true;
    if (!isValid) {
      return { valid: false, error: 'Unauthorized UUID' };
    }

    console.log(`[VLESS] Valid UUID: ${uuid}`);

    // Additional info
    const addLen = buffer[offset++];
    offset += addLen;

    // Command
    const command = buffer[offset++];
    if (command !== 1) {
      return { valid: false, error: `Unsupported command: ${command}` };
    }

    // Port (big-endian)
    const port = (buffer[offset] << 8) | buffer[offset + 1];
    offset += 2;

    // Address type
    const addrType = buffer[offset++];
    let address = '';

    if (addrType === 1) {
      // IPv4
      address = `${buffer[offset]}.${buffer[offset+1]}.${buffer[offset+2]}.${buffer[offset+3]}`;
      offset += 4;
    } else if (addrType === 2) {
      // Domain
      const domainLen = buffer[offset++];
      const domainBytes = buffer.slice(offset, offset + domainLen);
      address = new TextDecoder().decode(domainBytes);
      offset += domainLen;
    } else if (addrType === 3) {
      // IPv6
      const ipv6 = [];
      for (let i = 0; i < 16; i += 2) {
        ipv6.push(((buffer[offset+i] << 8) | buffer[offset+i+1]).toString(16));
      }
      address = ipv6.join(':');
      offset += 16;
    } else {
      return { valid: false, error: `Invalid address type: ${addrType}` };
    }

    // Remaining payload
    const payload = buffer.slice(offset);

    return {
      valid: true,
      uuid,
      address,
      port,
      payload
    };

  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// UUID validation (async check with KV)
async function validateUUID(uuid, env) {
  try {
    const account = await env.VLESS_KV.get(uuid);
    return account !== null;
  } catch (error) {
    console.error('UUID validation error:', error);
    return false;
  }
}

// Convert bytes to UUID string
function bytesToUUID(bytes) {
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32)
  ].join('-');
}

// Safe WebSocket close
function safeClose(ws, code = 1000, reason = '') {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(code, reason);
    }
  } catch (e) {
    console.error('Error closing WebSocket:', e);
  }
}

// =====================================================
// HTML INTERFACE
// =====================================================

function getHTML() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VLESS VPN - SNI Routing</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 min-h-screen">
  <div id="app"></div>
  
  <script type="module">
    const { signal, effect, computed } = await import('https://cdn.jsdelivr.net/npm/@preact/signals-core@1.5.1/+esm');
    
    // State
    const config = signal({
      server: '',
      port: '443',
      path: '/',
      wsHost: location.hostname,
      sni: '',
      security: 'tls'
    });
    
    const accounts = signal([]);
    const result = signal(null);
    const status = signal('');
    const copied = signal('');

    // Load accounts
    async function loadAccounts() {
      try {
        const res = await fetch('/api/accounts');
        const data = await res.json();
        accounts.value = data.accounts || [];
      } catch (e) {
        console.error(e);
      }
    }

    // Generate UUID
    function genUUID() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }

    // Create account
    async function createAccount() {
      const cfg = config.value;
      if (!cfg.server || !cfg.sni) {
        status.value = 'error';
        setTimeout(() => status.value = '', 3000);
        return;
      }

      status.value = 'loading';

      try {
        const uuid = genUUID();
        const payload = {
          uuid,
          server: cfg.server,
          port: cfg.port,
          path: cfg.path,
          wsHost: cfg.wsHost,
          sni: cfg.sni,
          security: cfg.security
        };

        const res = await fetch('/api/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          const vlessLink = \`vless://\${uuid}@\${cfg.server}:\${cfg.port}?type=ws&security=\${cfg.security}&path=\${encodeURIComponent(cfg.path)}&host=\${cfg.wsHost}&sni=\${cfg.sni}&alpn=h2,http/1.1&fp=chrome#VLESS-\${Date.now()}\`;
          
          result.value = { ...payload, vlessLink };
          status.value = 'success';
          await loadAccounts();
        } else {
          status.value = 'error';
        }
      } catch (e) {
        status.value = 'error';
        console.error(e);
      }
    }

    // Copy to clipboard
    function copy(text, field) {
      navigator.clipboard.writeText(text);
      copied.value = field;
      setTimeout(() => copied.value = '', 2000);
    }

    // Delete account
    async function deleteAccount(uuid) {
      if (!confirm('Delete this account?')) return;
      try {
        await fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uuid })
        });
        await loadAccounts();
      } catch (e) {
        console.error(e);
      }
    }

    // Render
    function render() {
      const app = document.getElementById('app');
      const cfg = config.value;
      const res = result.value;
      const accs = accounts.value;
      const st = status.value;
      const cp = copied.value;

      app.innerHTML = \`
        <div class="container mx-auto px-4 py-8 max-w-5xl">
          <!-- Header -->
          <div class="text-center mb-8">
            <div class="inline-flex items-center justify-center w-20 h-20 bg-purple-500/20 rounded-full mb-4">
              <svg class="w-10 h-10 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
              </svg>
            </div>
            <h1 class="text-4xl font-bold text-white mb-2">VLESS VPN Generator</h1>
            <p class="text-purple-300">Advanced SNI Routing + Bug Hosting</p>
          </div>

          <!-- Status -->
          \${st === 'loading' ? \`
            <div class="mb-6 bg-blue-500/20 border border-blue-400 rounded-xl p-4">
              <div class="flex items-center gap-3">
                <div class="animate-spin rounded-full h-5 w-5 border-2 border-blue-400 border-t-transparent"></div>
                <span class="text-white">Creating VLESS account...</span>
              </div>
            </div>
          \` : ''}

          \${st === 'success' ? \`
            <div class="mb-6 bg-green-500/20 border border-green-400 rounded-xl p-4">
              <div class="flex items-center gap-3">
                <svg class="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                </svg>
                <span class="text-white font-semibold">VLESS account created successfully!</span>
              </div>
            </div>
          \` : ''}

          \${st === 'error' ? \`
            <div class="mb-6 bg-red-500/20 border border-red-400 rounded-xl p-4">
              <div class="flex items-center gap-3">
                <svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
                <span class="text-white">Failed. Check your configuration.</span>
              </div>
            </div>
          \` : ''}

          <!-- Main Card -->
          \${!res ? \`
            <div class="bg-white/5 backdrop-blur-xl rounded-2xl p-8 border border-white/10 shadow-2xl">
              <div class="space-y-6">
                
                <!-- Info Box -->
                <div class="bg-purple-500/10 border border-purple-400/30 rounded-xl p-4 mb-6">
                  <h3 class="text-white font-semibold mb-2 flex items-center gap-2">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                    </svg>
                    Cara Konfigurasi SNI Routing
                  </h3>
                  <div class="text-sm text-purple-200 space-y-2">
                    <p><strong>Contoh 1 (Normal):</strong></p>
                    <p class="ml-4">• Server: developer.mixpanel.com<br>• WebSocket Host: \${cfg.wsHost}<br>• SNI: \${cfg.wsHost}</p>
                    
                    <p class="mt-3"><strong>Contoh 2 (Bug Hosting):</strong></p>
                    <p class="ml-4">• Server: \${cfg.wsHost}<br>• WebSocket Host: \${cfg.wsHost}<br>• SNI: graph.facebook.com</p>
                  </div>
                </div>

                <!-- Form -->
                <div class="space-y-4">
                  <div>
                    <label class="block text-sm font-medium text-purple-200 mb-2">Target Server *</label>
                    <input
                      type="text"
                      value="\${cfg.server}"
                      oninput="config.value = {...config.value, server: this.value}"
                      placeholder="developer.mixpanel.com atau IP"
                      class="w-full px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-400/50"
                    />
                    <p class="text-xs text-gray-400 mt-1">Server tujuan yang akan diakses</p>
                  </div>

                  <div class="grid grid-cols-2 gap-4">
                    <div>
                      <label class="block text-sm font-medium text-purple-200 mb-2">Port</label>
                      <select
                        value="\${cfg.port}"
                        onchange="config.value = {...config.value, port: this.value, security: this.value === '443' ? 'tls' : 'none'}"
                        class="w-full px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white focus:outline-none focus:border-purple-400"
                      >
                        <option value="443">443 (TLS)</option>
                        <option value="80">80</option>
                        <option value="8080">8080</option>
                        <option value="8443">8443</option>
                      </select>
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-purple-200 mb-2">Path</label>
                      <input
                        type="text"
                        value="\${cfg.path}"
                        oninput="config.value = {...config.value, path: this.value}"
                        class="w-full px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white focus:outline-none focus:border-purple-400"
                      />
                    </div>
                  </div>

                  <div>
                    <label class="block text-sm font-medium text-purple-200 mb-2">WebSocket Host</label>
                    <input
                      type="text"
                      value="\${cfg.wsHost}"
                      oninput="config.value = {...config.value, wsHost: this.value}"
                      class="w-full px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white focus:outline-none focus:border-purple-400"
                    />
                    <p class="text-xs text-gray-400 mt-1">Host header untuk WebSocket (biasanya worker domain)</p>
                  </div>

                  <div>
                    <label class="block text-sm font-medium text-purple-200 mb-2">SNI (Server Name Indication) *</label>
                    <input
                      type="text"
                      value="\${cfg.sni}"
                      oninput="config.value = {...config.value, sni: this.value}"
                      placeholder="graph.facebook.com atau domain bug"
                      class="w-full px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-400/50"
                    />
                    <p class="text-xs text-gray-400 mt-1">Domain untuk TLS handshake (bisa berbeda dengan server)</p>
                  </div>

                  <button
                    onclick="createAccount()"
                    class="w-full py-4 bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-600 hover:to-pink-700 text-white font-semibold rounded-lg transition-all shadow-lg hover:shadow-xl"
                  >
                    🚀 Create VLESS Account
                  </button>
                </div>

                <!-- Features -->
                <div class="bg-green-500/10 border border-green-400/20 rounded-xl p-4 mt-6">
                  <div class="grid grid-cols-2 gap-2 text-sm text-green-200">
                    <div>✅ Full VLESS Protocol</div>
                    <div>✅ SNI Routing</div>
                    <div>✅ Bug Hosting Support</div>
                    <div>✅ Bidirectional Proxy</div>
                  </div>
                </div>
              </div>
            </div>
          \` : \`
            <div class="bg-white/5 backdrop-blur-xl rounded-2xl p-8 border border-white/10 shadow-2xl">
              <h2 class="text-2xl font-bold text-white mb-6 flex items-center gap-2">
                <svg class="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                </svg>
                VLESS Configuration Ready
              </h2>

              <div class="space-y-4">
                <div class="bg-white/5 rounded-xl p-4">
                  <label class="block text-sm font-medium text-purple-200 mb-2">UUID</label>
                  <div class="flex items-center gap-2">
                    <code class="flex-1 bg-black/30 px-3 py-2 rounded text-green-400 text-sm break-all">\${res.uuid}</code>
                    <button onclick="copy('\${res.uuid}', 'uuid')" class="px-4 py-2 bg-purple-500 hover:bg-purple-600 rounded-lg text-white text-sm">
                      \${cp === 'uuid' ? '✓' : '📋'}
                    </button>
                  </div>
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div class="bg-white/5 rounded-xl p-4">
                    <label class="block text-sm text-purple-200 mb-1">Server</label>
                    <p class="text-white font-mono text-sm">\${res.server}:\${res.port}</p>
                  </div>
                  <div class="bg-white/5 rounded-xl p-4">
                    <label class="block text-sm text-purple-200 mb-1">SNI</label>
                    <p class="text-white font-mono text-sm">\${res.sni}</p>
                  </div>
                </div>

                <div class="bg-white/5 rounded-xl p-4">
                  <label class="block text-sm font-medium text-purple-200 mb-2">VLESS Link</label>
                  <div class="flex items-center gap-2">
                    <code class="flex-1 bg-black/30 px-3 py-2 rounded text-green-400 text-xs break-all max-h-24 overflow-y-auto">\${res.vlessLink}</code>
                    <button onclick="copy('\${res.vlessLink}', 'link')" class="px-4 py-2 bg-purple-500 hover:bg-purple-600 rounded-lg text-white text-sm">
                      \${cp === 'link' ? '✓' : '📋'}
                    </button>
                  </div>
                </div>

                <button onclick="result.value = null; status.value = ''" class="w-full py-3 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-lg">
                  Create New Account
                </button>
              </div>
            </div>
          \`}

          <!-- Saved Accounts -->
          \${accs.length > 0 ? \`
            <div class="mt-6 bg-white/5 backdrop-blur-xl rounded-2xl p-8 border border-white/10 shadow-2xl">
              <h2 class="text-xl font-bold text-white mb-4">Saved Accounts (\${accs.length})</h2>
              <div class="space-y-3 max-h-96 overflow-y-auto">
                \${accs.map((acc, i) => \`
                  <div class="bg-white/5 rounded-xl p-4 flex justify-between items-start">
                    <div class="flex-1">
                      <p class="text-white font-mono text-xs mb-1">\${acc.uuid}</p>
                      <p class="text-purple-300 text-xs">Server: \${acc.server}:\${acc.port}</p>
                      <p class="text-gray-400 text-xs">SNI: \${acc.sni}</p>
                    </div>
                    <div class="flex gap-2">
                      <button onclick="copy('\${acc.uuid}', 'acc-\${i}')" class="px-3 py-1 bg-purple-500/50 hover:bg-purple-500 rounded text-white text-sm">
                        \${cp === \`acc-\${i}\` ? '✓' : '📋'}
                      </button>
                      <button onclick="deleteAccount('\${acc.uuid}')" class="px-3 py-1 bg-red-500/50 hover:bg-red-500 rounded text-white text-sm">
                        🗑️
                      </button>
                    </div>
                  </div>
                \`).join('')}
              </div>
            </div>
          \` : ''}

          <!-- Footer -->
          <div class="text-center mt-8">
            <p class="text-gray-400 text-sm">Powered by Cloudflare Workers • Full VLESS Protocol</p>
          </div>
        </div>
      \`;
    }

    // Make functions global
    window.createAccount = createAccount;
    window.copy = copy;
    window.deleteAccount = deleteAccount;

    // Auto-render on state change
    effect(() => {
      config.value;
      accounts.value;
      result.value;
      status.value;
      copied.value;
      render();
    });

    // Initial load
    loadAccounts();
    render();
  </script>
</body>
</html>`;
}
