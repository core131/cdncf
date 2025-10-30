// worker.js - Cloudflare Workers Entry Point
// Tidak ada React di sini - hanya JavaScript murni

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // API Routes
    if (url.pathname === '/api/accounts') {
      return handleGetAccounts(env, corsHeaders);
    }

    if (url.pathname === '/api/create-vless') {
      return handleCreateVLESS(request, env, corsHeaders);
    }

    if (url.pathname === '/api/account') {
      return handleGetAccount(request, env, corsHeaders);
    }

    // WebSocket upgrade untuk VLESS protocol
    if (request.headers.get('Upgrade') === 'websocket') {
      return handleVLESSWebSocket(request, env);
    }

    // Serve HTML Frontend
    return new Response(getHTML(), {
      headers: { 
        'Content-Type': 'text/html',
        ...corsHeaders 
      }
    });
  }
};

// Handler untuk mendapatkan semua akun
async function handleGetAccounts(env, corsHeaders) {
  try {
    const list = await env.VLESS_ACCOUNTS.list();
    const accounts = [];
    
    for (const key of list.keys) {
      const account = await env.VLESS_ACCOUNTS.get(key.name);
      if (account) {
        accounts.push(JSON.parse(account));
      }
    }

    return new Response(JSON.stringify({ accounts }), {
      headers: { 
        'Content-Type': 'application/json',
        ...corsHeaders 
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 
        'Content-Type': 'application/json',
        ...corsHeaders 
      }
    });
  }
}

// Handler untuk membuat akun VLESS
async function handleCreateVLESS(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { uuid, address, port, path, host, sni } = body;

    const vlessAccount = {
      uuid,
      protocol: 'vless',
      address,
      port,
      path,
      host,
      sni,
      type: 'ws',
      security: port === '443' ? 'tls' : 'none',
      createdAt: new Date().toISOString()
    };

    // Simpan ke Cloudflare KV dengan UUID sebagai key
    await env.VLESS_ACCOUNTS.put(uuid, JSON.stringify(vlessAccount));

    return new Response(JSON.stringify({ 
      success: true, 
      account: vlessAccount 
    }), {
      headers: { 
        'Content-Type': 'application/json',
        ...corsHeaders 
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), {
      status: 500,
      headers: { 
        'Content-Type': 'application/json',
        ...corsHeaders 
      }
    });
  }
}

// Handler untuk mendapatkan akun spesifik
async function handleGetAccount(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const uuid = url.searchParams.get('uuid');

    if (!uuid) {
      return new Response(JSON.stringify({ error: 'UUID required' }), {
        status: 400,
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders 
        }
      });
    }

    const account = await env.VLESS_ACCOUNTS.get(uuid);
    
    if (!account) {
      return new Response(JSON.stringify({ error: 'Account not found' }), {
        status: 404,
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders 
        }
      });
    }

    return new Response(account, {
      headers: { 
        'Content-Type': 'application/json',
        ...corsHeaders 
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 
        'Content-Type': 'application/json',
        ...corsHeaders 
      }
    });
  }
}

// Handler untuk WebSocket VLESS - Versi Diperbaiki dengan Stream Piping
async function handleVLESSWebSocket(request, env) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();

    const log = (...args) => console.log('[VLESS]', ...args);
    const readableWebSocketStream = makeReadableWebSocketStream(server, log);

    let remoteSocket;
    const writer = readableWebSocketStream.getWriter();

    try {
        // Baca header VLESS dari pesan pertama
        const { value: firstChunk, done } = await writer.read();
        if (done || !firstChunk) {
            throw new Error('No VLESS header received.');
        }

        const headerData = parseVLESSHeader(firstChunk);
        if (headerData.error) {
            throw new Error(headerData.error);
        }

        const { uuid, address, port, payload } = headerData;

        // Validasi UUID
        const account = await env.VLESS_ACCOUNTS.get(uuid);
        if (!account) {
            throw new Error(`Invalid UUID: ${uuid}`);
        }

        log(`Connecting to ${address}:${port}`);

        // Kirim balasan sukses VLESS
        server.send(new Uint8Array([0, 0]));

        // Buat koneksi ke tujuan
        remoteSocket = await connect({ hostname: address, port });
        log('Connection to destination established.');

        // Tulis payload awal (jika ada) ke tujuan
        if (payload.byteLength > 0) {
            const writer = remoteSocket.writable.getWriter();
            await writer.write(payload);
            writer.releaseLock();
        }

        // Buat WritableStream untuk WebSocket agar bisa menerima data dari remote
        const writableWebSocketStream = new WritableStream({
            async write(chunk) {
                server.send(chunk);
            },
            close() {
                log('WebSocket writable stream closed.');
            },
            abort(err) {
                log('WebSocket writable stream aborted:', err);
            },
        });

        // Melepaskan lock pada reader stream WebSocket klien agar bisa di-pipe
        writer.releaseLock();

        // Mulai piping dua arah
        await Promise.all([
            remoteSocket.readable.pipeTo(writableWebSocketStream),
            readableWebSocketStream.pipeTo(remoteSocket.writable),
        ]).catch((err) => {
            log('Piping error:', err);
        });

    } catch (err) {
        log('Error in handleVLESSWebSocket:', err);
        server.close(1011, err.message);
        if (remoteSocket) {
            remoteSocket.close();
        }
    }

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

/**
 * Mengubah WebSocket menjadi ReadableStream untuk penanganan backpressure yang lebih baik.
 */
function makeReadableWebSocketStream(webSocketServer, log) {
    let readableStreamController;
    const stream = new ReadableStream({
        start(controller) {
            readableStreamController = controller;
            webSocketServer.addEventListener('message', (event) => {
                // Pastikan data dalam format yang benar (ArrayBuffer)
                const data = event.data instanceof ArrayBuffer ? event.data : new TextEncoder().encode(event.data).buffer;
                readableStreamController.enqueue(new Uint8Array(data));
            });
            webSocketServer.addEventListener('close', () => {
                log('Client WebSocket closed, closing readable stream.');
                readableStreamController.close();
            });
            webSocketServer.addEventListener('error', (err) => {
                log('Client WebSocket error:', err);
                readableStreamController.error(err);
            });
        },
        cancel() {
            log('Readable stream cancelled.');
            if (webSocketServer.readyState === WebSocket.OPEN) {
                webSocketServer.close(1000, 'Stream cancelled');
            }
        },
    });

    return stream;
}

// Correctly parse VLESS header from an ArrayBuffer
function parseVLESSHeader(buffer) {
  const dataView = new DataView(buffer);
  let offset = 0;

  // VLESS Version (1 byte)
  const version = dataView.getUint8(offset);
  offset += 1;
  if (version !== 0) {
    return { error: 'Invalid VLESS version' };
  }

  // UUID (16 bytes)
  const uuidBytes = new Uint8Array(buffer, offset, 16);
  let uuid = '';
  for (let i = 0; i < 16; i++) {
    uuid += uuidBytes[i].toString(16).padStart(2, '0');
  }
  uuid = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
  offset += 16;

  // Add-ons length (1 byte) - skip them
  const addOnLength = dataView.getUint8(offset);
  offset += 1 + addOnLength;

  // Command (1 byte)
  const command = dataView.getUint8(offset);
  offset += 1;
  if (command !== 1) { // 1 = TCP, 2 = UDP
    return { error: 'Unsupported command: only TCP is allowed' };
  }

  // Port (2 bytes, Big Endian)
  const port = dataView.getUint16(offset);
  offset += 2;

  // Address Type (1 byte)
  const addressType = dataView.getUint8(offset);
  offset += 1;
  let address = '';

  switch (addressType) {
    case 1: // IPv4
      const ipv4Bytes = new Uint8Array(buffer, offset, 4);
      address = Array.from(ipv4Bytes).join('.');
      offset += 4;
      break;
    case 2: // Domain
      const domainLength = dataView.getUint8(offset);
      offset += 1;
      const domainBytes = new Uint8Array(buffer, offset, domainLength);
      address = new TextDecoder().decode(domainBytes);
      offset += domainLength;
      break;
    case 3: // IPv6
      const ipv6Bytes = new Uint8Array(buffer, offset, 16);
      const ipv6 = [];
      for (let i = 0; i < 16; i += 2) {
        ipv6.push(dataView.getUint16(offset + i).toString(16));
      }
      address = ipv6.join(':');
      offset += 16;
      break;
    default:
      return { error: 'Invalid address type' };
  }

  // The rest of the buffer is the initial payload
  const payload = buffer.slice(offset);

  return {
    uuid,
    address,
    port,
    payload, // This is an ArrayBuffer
  };
}

// HTML Frontend dengan React embedded
function getHTML() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VLESS VPN Generator - Cloudflare Workers</title>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  
  <script>
    const { useState, useEffect } = React;
    const e = React.createElement;

    // Lucide Icons as SVG components
    const WifiIcon = () => e('svg', { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 }, 
      e('path', { d: 'M5 13a10 10 0 0 1 14 0' }),
      e('path', { d: 'M8.5 16.5a5 5 0 0 1 7 0' }),
      e('path', { d: 'M2 8.82a15 15 0 0 1 20 0' }),
      e('circle', { cx: 12, cy: 20, r: 1 })
    );

    const ShieldIcon = () => e('svg', { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
      e('path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' })
    );

    const ServerIcon = () => e('svg', { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
      e('rect', { x: 2, y: 2, width: 20, height: 8, rx: 2, ry: 2 }),
      e('rect', { x: 2, y: 14, width: 20, height: 8, rx: 2, ry: 2 }),
      e('line', { x1: 6, y1: 6, x2: 6.01, y2: 6 }),
      e('line', { x1: 6, y1: 18, x2: 6.01, y2: 18 })
    );

    const CopyIcon = () => e('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
      e('rect', { x: 9, y: 9, width: 13, height: 13, rx: 2, ry: 2 }),
      e('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' })
    );

    const CheckIcon = () => e('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
      e('polyline', { points: '20 6 9 17 4 12' })
    );

    const AlertIcon = () => e('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
      e('circle', { cx: 12, cy: 12, r: 10 }),
      e('line', { x1: 12, y1: 8, x2: 12, y2: 12 }),
      e('line', { x1: 12, y1: 16, x2: 12.01, y2: 16 })
    );

    function VLESSVPNApp() {
      const [proxyHost, setProxyHost] = useState('');
      const [proxyPort, setProxyPort] = useState('443');
      const [proxyPath, setProxyPath] = useState('/ws');
      const [cdnDomain, setCdnDomain] = useState('');
      const [isConnecting, setIsConnecting] = useState(false);
      const [connectionStatus, setConnectionStatus] = useState('');
      const [vlessConfig, setVlessConfig] = useState(null);
      const [copiedField, setCopiedField] = useState('');
      const [accounts, setAccounts] = useState([]);

      useEffect(() => {
        loadAccounts();
      }, []);

      const loadAccounts = async () => {
        try {
          const response = await fetch('/api/accounts');
          if (response.ok) {
            const data = await response.json();
            setAccounts(data.accounts || []);
          }
        } catch (error) {
          console.error('Error loading accounts:', error);
        }
      };

      const generateUUID = () => {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      };

      const handleConnect = async () => {
        if (!proxyHost || !cdnDomain) {
          setConnectionStatus('error');
          setTimeout(() => setConnectionStatus(''), 3000);
          return;
        }

        setIsConnecting(true);
        setConnectionStatus('connecting');

        try {
          const uuid = generateUUID();
          const timestamp = new Date().toISOString();
          
          const config = {
            uuid: uuid,
            protocol: 'vless',
            address: cdnDomain,
            port: proxyPort,
            type: 'ws',
            security: proxyPort === '443' ? 'tls' : 'none',
            path: proxyPath,
            host: proxyHost,
            sni: cdnDomain,
            alpn: 'h2,http/1.1',
            fingerprint: 'chrome',
            createdAt: timestamp
          };

          // Simpan ke backend
          const response = await fetch('/api/create-vless', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
          });

          if (response.ok) {
            const vlessLink = \`vless://\${uuid}@\${cdnDomain}:\${proxyPort}?type=ws&security=\${config.security}&path=\${encodeURIComponent(proxyPath)}&host=\${proxyHost}&sni=\${cdnDomain}&alpn=h2,http/1.1&fp=chrome#VLESS-CDN-\${Date.now()}\`;

            setVlessConfig({
              ...config,
              vlessLink: vlessLink
            });

            await loadAccounts();
            setConnectionStatus('success');
          } else {
            setConnectionStatus('error');
          }
        } catch (error) {
          setConnectionStatus('error');
          console.error('Connection error:', error);
        } finally {
          setIsConnecting(false);
        }
      };

      const copyToClipboard = (text, field) => {
        navigator.clipboard.writeText(text);
        setCopiedField(field);
        setTimeout(() => setCopiedField(''), 2000);
      };

      const handleReset = () => {
        setVlessConfig(null);
        setConnectionStatus('');
      };

      return e('div', { className: 'min-h-screen bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900 p-4' },
        e('div', { className: 'max-w-4xl mx-auto' },
          // Header
          e('div', { className: 'text-center mb-8 pt-8' },
            e('div', { className: 'flex items-center justify-center mb-4' },
              e(ShieldIcon, { className: 'w-16 h-16 text-blue-400' })
            ),
            e('h1', { className: 'text-4xl font-bold text-white mb-2' }, 'VLESS VPN Generator'),
            e('p', { className: 'text-blue-200' }, 'Cloudflare Workers + CDN Integration')
          ),

          // Status Notifications
          connectionStatus === 'connecting' && e('div', { className: 'mb-6 bg-blue-500/20 border border-blue-400 rounded-lg p-4 text-center' },
            e('div', { className: 'flex items-center justify-center gap-2' },
              e('div', { className: 'animate-spin rounded-full h-5 w-5 border-b-2 border-white' }),
              e('p', { className: 'text-white' }, 'Membuat koneksi VLESS...')
            )
          ),

          connectionStatus === 'success' && e('div', { className: 'mb-6 bg-green-500/20 border border-green-400 rounded-lg p-4' },
            e('div', { className: 'flex items-center gap-2' },
              e(CheckIcon),
              e('p', { className: 'text-white font-semibold' }, 'Koneksi VPN berhasil dibuat dan disimpan di Cloudflare KV!')
            )
          ),

          connectionStatus === 'error' && e('div', { className: 'mb-6 bg-red-500/20 border border-red-400 rounded-lg p-4' },
            e('div', { className: 'flex items-center gap-2' },
              e(AlertIcon),
              e('p', { className: 'text-white' }, 'Gagal membuat koneksi. Periksa kembali detail proxy Anda.')
            )
          ),

          // Main Card
          !vlessConfig ? 
            e('div', { className: 'bg-white/10 backdrop-blur-lg rounded-2xl p-8 shadow-2xl border border-white/20' },
              e('div', { className: 'space-y-6' },
                e('div', null,
                  e('h2', { className: 'text-xl font-semibold text-white mb-4 flex items-center gap-2' },
                    e(ServerIcon),
                    'Konfigurasi Proxy'
                  ),
                  e('div', { className: 'space-y-4' },
                    e('div', null,
                      e('label', { className: 'block text-sm font-medium text-blue-200 mb-2' }, 'Proxy Host *'),
                      e('input', {
                        type: 'text',
                        value: proxyHost,
                        onChange: (ev) => setProxyHost(ev.target.value),
                        placeholder: 'contoh: worker.example.com',
                        className: 'w-full px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white placeholder-blue-300/50 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-400/50'
                      })
                    ),
                    e('div', { className: 'grid grid-cols-2 gap-4' },
                      e('div', null,
                        e('label', { className: 'block text-sm font-medium text-blue-200 mb-2' }, 'Port'),
                        e('select', {
                          value: proxyPort,
                          onChange: (ev) => setProxyPort(ev.target.value),
                          className: 'w-full px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white focus:outline-none focus:border-blue-400'
                        },
                          e('option', { value: '443' }, '443 (TLS)'),
                          e('option', { value: '80' }, '80 (Non-TLS)'),
                          e('option', { value: '8080' }, '8080'),
                          e('option', { value: '8443' }, '8443')
                        )
                      ),
                      e('div', null,
                        e('label', { className: 'block text-sm font-medium text-blue-200 mb-2' }, 'WebSocket Path'),
                        e('input', {
                          type: 'text',
                          value: proxyPath,
                          onChange: (ev) => setProxyPath(ev.target.value),
                          placeholder: '/ws',
                          className: 'w-full px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white placeholder-blue-300/50 focus:outline-none focus:border-blue-400'
                        })
                      )
                    ),
                    e('div', null,
                      e('label', { className: 'block text-sm font-medium text-blue-200 mb-2' }, 'CDN Domain (Cloudflare) *'),
                      e('input', {
                        type: 'text',
                        value: cdnDomain,
                        onChange: (ev) => setCdnDomain(ev.target.value),
                        placeholder: 'contoh: cdn.cloudflare.com',
                        className: 'w-full px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white placeholder-blue-300/50 focus:outline-none focus:border-blue-400'
                      })
                    )
                  )
                ),
                e('button', {
                  onClick: handleConnect,
                  disabled: isConnecting,
                  className: 'w-full py-4 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 disabled:from-gray-500 disabled:to-gray-600 text-white font-semibold rounded-lg transition-all duration-300 flex items-center justify-center gap-2 shadow-lg hover:shadow-xl disabled:cursor-not-allowed'
                },
                  e(WifiIcon),
                  isConnecting ? 'Menghubungkan...' : 'Hubungkan & Buat Akun VLESS'
                ),
                e('div', { className: 'bg-blue-500/10 border border-blue-400/30 rounded-lg p-4' },
                  e('p', { className: 'text-sm text-blue-200' },
                    e('strong', null, 'Protokol: '),
                    'VLESS + WebSocket (WS)',
                    e('br'),
                    e('strong', null, 'Keamanan: '),
                    'TLS + CDN Cloudflare',
                    e('br'),
                    e('strong', null, 'Penyimpanan: '),
                    'Cloudflare KV (UUID-based)'
                  )
                )
              )
            )
          :
            e('div', { className: 'bg-white/10 backdrop-blur-lg rounded-2xl p-8 shadow-2xl border border-white/20' },
              e('h2', { className: 'text-2xl font-bold text-white mb-6 flex items-center gap-2' },
                e(CheckIcon),
                'Konfigurasi VLESS Berhasil Dibuat'
              ),
              e('div', { className: 'space-y-4' },
                e('div', { className: 'bg-white/5 rounded-lg p-4' },
                  e('label', { className: 'block text-sm font-medium text-blue-200 mb-2' }, 'UUID (Disimpan di Cloudflare KV)'),
                  e('div', { className: 'flex items-center gap-2' },
                    e('code', { className: 'flex-1 bg-black/30 px-3 py-2 rounded text-green-400 text-sm break-all' }, vlessConfig.uuid),
                    e('button', {
                      onClick: () => copyToClipboard(vlessConfig.uuid, 'uuid'),
                      className: 'p-2 bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors'
                    }, copiedField === 'uuid' ? e(CheckIcon) : e(CopyIcon))
                  )
                ),
                e('div', { className: 'grid grid-cols-2 gap-4' },
                  e('div', { className: 'bg-white/5 rounded-lg p-4' },
                    e('label', { className: 'block text-sm font-medium text-blue-200 mb-2' }, 'Server'),
                    e('p', { className: 'text-white font-mono text-sm' }, vlessConfig.address)
                  ),
                  e('div', { className: 'bg-white/5 rounded-lg p-4' },
                    e('label', { className: 'block text-sm font-medium text-blue-200 mb-2' }, 'Port'),
                    e('p', { className: 'text-white font-mono text-sm' }, vlessConfig.port)
                  )
                ),
                e('div', { className: 'bg-white/5 rounded-lg p-4' },
                  e('label', { className: 'block text-sm font-medium text-blue-200 mb-2' }, 'VLESS Link (Import ke V2Ray/Xray/Sing-Box)'),
                  e('div', { className: 'flex items-center gap-2' },
                    e('code', { className: 'flex-1 bg-black/30 px-3 py-2 rounded text-green-400 text-xs break-all max-h-20 overflow-y-auto' }, vlessConfig.vlessLink),
                    e('button', {
                      onClick: () => copyToClipboard(vlessConfig.vlessLink, 'link'),
                      className: 'p-2 bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors'
                    }, copiedField === 'link' ? e(CheckIcon) : e(CopyIcon))
                  )
                ),
                e('button', {
                  onClick: handleReset,
                  className: 'w-full py-3 bg-gray-600 hover:bg-gray-700 text-white font-semibold rounded-lg transition-colors'
                }, 'Buat Akun Baru')
              )
            ),

          // Saved Accounts
          accounts.length > 0 && e('div', { className: 'mt-6 bg-white/10 backdrop-blur-lg rounded-2xl p-8 shadow-2xl border border-white/20' },
            e('h2', { className: 'text-xl font-bold text-white mb-4' }, \`Akun Tersimpan (\${accounts.length})\`),
            e('div', { className: 'space-y-3 max-h-64 overflow-y-auto' },
              accounts.map((account, index) => 
                e('div', { key: index, className: 'bg-white/5 rounded-lg p-3' },
                  e('div', { className: 'flex justify-between items-center' },
                    e('div', null,
                      e('p', { className: 'text-white font-mono text-xs' }, account.uuid),
                      e('p', { className: 'text-blue-300 text-xs' }, \`\${account.address}:\${account.port}\`)
                    ),
                    e('button', {
                      onClick: () => copyToClipboard(account.uuid, \`account-\${index}\`),
                      className: 'p-2 bg-blue-500/50 hover:bg-blue-500 rounded transition-colors'
                    }, copiedField === \`account-\${index}\` ? e(CheckIcon) : e(CopyIcon))
                  )
                )
              )
            )
          ),

          // Footer
          e('div', { className: 'text-center mt-8 pb-8' },
            e('p', { className: 'text-blue-300 text-sm' }, 'Powered by Cloudflare Workers + VLESS Protocol')
          )
        )
      );
    }

    // Render the app
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(e(VLESSVPNApp));
  </script>
</body>
</html>`;
}
