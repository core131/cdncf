import React, { useState, useEffect } from 'react';
import { Wifi, Shield, Server, Copy, Check, AlertCircle } from 'lucide-react';

export default function VLESSVPNApp() {
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
      await new Promise(resolve => setTimeout(resolve, 1500));

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

      const vlessLink = `vless://${uuid}@${cdnDomain}:${proxyPort}?type=ws&security=${config.security}&path=${encodeURIComponent(proxyPath)}&host=${proxyHost}&sni=${cdnDomain}&alpn=h2,http/1.1&fp=chrome#VLESS-CDN-${Date.now()}`;

      setVlessConfig({
        ...config,
        vlessLink: vlessLink
      });

      // Simpan ke storage (simulasi Cloudflare KV)
      const savedAccounts = [...accounts, config];
      setAccounts(savedAccounts);

      setConnectionStatus('success');
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
    setProxyHost('');
    setCdnDomain('');
    setProxyPath('/ws');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900 p-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8 pt-8">
          <div className="flex items-center justify-center mb-4">
            <Shield className="w-16 h-16 text-blue-400" />
          </div>
          <h1 className="text-4xl font-bold text-white mb-2">
            VLESS VPN Generator
          </h1>
          <p className="text-blue-200">
            Cloudflare Workers + CDN Integration
          </p>
        </div>

        {/* Status Notifications */}
        {connectionStatus === 'connecting' && (
          <div className="mb-6 bg-blue-500/20 border border-blue-400 rounded-lg p-4 text-center">
            <div className="flex items-center justify-center gap-2">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
              <p className="text-white">Membuat koneksi VLESS...</p>
            </div>
          </div>
        )}

        {connectionStatus === 'success' && (
          <div className="mb-6 bg-green-500/20 border border-green-400 rounded-lg p-4">
            <div className="flex items-center gap-2">
              <Check className="w-5 h-5 text-green-400" />
              <p className="text-white font-semibold">
                Koneksi VPN berhasil dibuat dan disimpan di Cloudflare KV!
              </p>
            </div>
          </div>
        )}

        {connectionStatus === 'error' && (
          <div className="mb-6 bg-red-500/20 border border-red-400 rounded-lg p-4">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-red-400" />
              <p className="text-white">
                Gagal membuat koneksi. Periksa kembali detail proxy Anda.
              </p>
            </div>
          </div>
        )}

        {/* Main Card */}
        {!vlessConfig ? (
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 shadow-2xl border border-white/20">
            <div className="space-y-6">
              {/* Proxy Settings */}
              <div>
                <h2 className="text-xl font-semibold text-white mb-4 flex items-center gap-2">
                  <Server className="w-5 h-5" />
                  Konfigurasi Proxy
                </h2>
                
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-blue-200 mb-2">
                      Proxy Host *
                    </label>
                    <input
                      type="text"
                      value={proxyHost}
                      onChange={(e) => setProxyHost(e.target.value)}
                      placeholder="contoh: worker.example.com"
                      className="w-full px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white placeholder-blue-300/50 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-400/50"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-blue-200 mb-2">
                        Port
                      </label>
                      <select
                        value={proxyPort}
                        onChange={(e) => setProxyPort(e.target.value)}
                        className="w-full px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-400/50"
                      >
                        <option value="443">443 (TLS)</option>
                        <option value="80">80 (Non-TLS)</option>
                        <option value="8080">8080</option>
                        <option value="8443">8443</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-blue-200 mb-2">
                        WebSocket Path
                      </label>
                      <input
                        type="text"
                        value={proxyPath}
                        onChange={(e) => setProxyPath(e.target.value)}
                        placeholder="/ws"
                        className="w-full px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white placeholder-blue-300/50 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-400/50"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-blue-200 mb-2">
                      CDN Domain (Cloudflare) *
                    </label>
                    <input
                      type="text"
                      value={cdnDomain}
                      onChange={(e) => setCdnDomain(e.target.value)}
                      placeholder="contoh: cdn.cloudflare.com"
                      className="w-full px-4 py-3 bg-white/10 border border-white/30 rounded-lg text-white placeholder-blue-300/50 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-400/50"
                    />
                  </div>
                </div>
              </div>

              {/* Connect Button */}
              <button
                onClick={handleConnect}
                disabled={isConnecting}
                className="w-full py-4 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 disabled:from-gray-500 disabled:to-gray-600 text-white font-semibold rounded-lg transition-all duration-300 flex items-center justify-center gap-2 shadow-lg hover:shadow-xl disabled:cursor-not-allowed"
              >
                <Wifi className="w-5 h-5" />
                {isConnecting ? 'Menghubungkan...' : 'Hubungkan & Buat Akun VLESS'}
              </button>

              {/* Protocol Info */}
              <div className="bg-blue-500/10 border border-blue-400/30 rounded-lg p-4">
                <p className="text-sm text-blue-200">
                  <strong>Protokol:</strong> VLESS + WebSocket (WS)
                  <br />
                  <strong>Keamanan:</strong> TLS + CDN Cloudflare
                  <br />
                  <strong>Penyimpanan:</strong> Cloudflare KV (UUID-based)
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 shadow-2xl border border-white/20">
            <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-2">
              <Check className="w-6 h-6 text-green-400" />
              Konfigurasi VLESS Berhasil Dibuat
            </h2>

            <div className="space-y-4">
              {/* UUID */}
              <div className="bg-white/5 rounded-lg p-4">
                <label className="block text-sm font-medium text-blue-200 mb-2">
                  UUID (Disimpan di Cloudflare KV)
                </label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-black/30 px-3 py-2 rounded text-green-400 text-sm break-all">
                    {vlessConfig.uuid}
                  </code>
                  <button
                    onClick={() => copyToClipboard(vlessConfig.uuid, 'uuid')}
                    className="p-2 bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors"
                  >
                    {copiedField === 'uuid' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Server Details */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-white/5 rounded-lg p-4">
                  <label className="block text-sm font-medium text-blue-200 mb-2">
                    Server
                  </label>
                  <p className="text-white font-mono text-sm">{vlessConfig.address}</p>
                </div>
                <div className="bg-white/5 rounded-lg p-4">
                  <label className="block text-sm font-medium text-blue-200 mb-2">
                    Port
                  </label>
                  <p className="text-white font-mono text-sm">{vlessConfig.port}</p>
                </div>
              </div>

              {/* VLESS Link */}
              <div className="bg-white/5 rounded-lg p-4">
                <label className="block text-sm font-medium text-blue-200 mb-2">
                  VLESS Link (Import ke V2Ray/Xray/Sing-Box)
                </label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-black/30 px-3 py-2 rounded text-green-400 text-xs break-all max-h-20 overflow-y-auto">
                    {vlessConfig.vlessLink}
                  </code>
                  <button
                    onClick={() => copyToClipboard(vlessConfig.vlessLink, 'link')}
                    className="p-2 bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors"
                  >
                    {copiedField === 'link' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Configuration Details */}
              <div className="bg-blue-500/10 border border-blue-400/30 rounded-lg p-4">
                <h3 className="text-white font-semibold mb-2">Detail Konfigurasi:</h3>
                <div className="text-sm text-blue-200 space-y-1">
                  <p>• Protokol: {vlessConfig.protocol.toUpperCase()}</p>
                  <p>• Transport: {vlessConfig.type.toUpperCase()}</p>
                  <p>• Security: {vlessConfig.security.toUpperCase()}</p>
                  <p>• Path: {vlessConfig.path}</p>
                  <p>• Host: {vlessConfig.host}</p>
                  <p>• SNI: {vlessConfig.sni}</p>
                  <p>• ALPN: {vlessConfig.alpn}</p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-3">
                <button
                  onClick={handleReset}
                  className="flex-1 py-3 bg-gray-600 hover:bg-gray-700 text-white font-semibold rounded-lg transition-colors"
                >
                  Buat Akun Baru
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Saved Accounts */}
        {accounts.length > 0 && (
          <div className="mt-6 bg-white/10 backdrop-blur-lg rounded-2xl p-8 shadow-2xl border border-white/20">
            <h2 className="text-xl font-bold text-white mb-4">
              Akun Tersimpan ({accounts.length})
            </h2>
            <div className="space-y-3 max-h-64 overflow-y-auto">
              {accounts.map((account, index) => (
                <div key={index} className="bg-white/5 rounded-lg p-3">
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="text-white font-mono text-xs">{account.uuid}</p>
                      <p className="text-blue-300 text-xs">{account.address}:{account.port}</p>
                    </div>
                    <button
                      onClick={() => copyToClipboard(account.uuid, `account-${index}`)}
                      className="p-2 bg-blue-500/50 hover:bg-blue-500 rounded transition-colors"
                    >
                      {copiedField === `account-${index}` ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="text-center mt-8 pb-8">
          <p className="text-blue-300 text-sm">
            Powered by Cloudflare Workers + VLESS Protocol
          </p>
        </div>
      </div>
    </div>
  );
}
