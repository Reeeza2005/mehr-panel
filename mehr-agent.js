// =============================================================================
// Mehr Agent Node (Headless Edge Worker)
// Core: BPB Lightweight VLESS Stream Engine
// =============================================================================

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // 1. Secret Management API (Sync & Stats)
        const authHeader = request.headers.get('Authorization') || '';
        const apiKey = authHeader.replace(/^Bearer\s+/i, '').trim();
        const expectedKey = env.API_KEY || '';

        // API Endpoint: Sync Users from Master Panel
        if (url.pathname === '/api/sync' && request.method === 'POST') {
            if (!expectedKey || apiKey !== expectedKey) {
                return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 });
            }
            try {
                const body = await request.json();
                if (body.config && env.KV) {
                    await env.KV.put('nahan_config', JSON.stringify(body.config));
                }
                return new Response(JSON.stringify({ success: true, message: 'Synced successfully' }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (err) {
                return new Response(JSON.stringify({ success: false, error: err.message }), { status: 400 });
            }
        }

        // API Endpoint: Report Traffic Stats to Master Panel
        if (url.pathname === '/api/stats' && request.method === 'GET') {
            if (!expectedKey || apiKey !== expectedKey) {
                return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 });
            }
            try {
                let stats = {};
                if (env.KV) {
                    const rawStats = await env.KV.get('agent_user_stats');
                    if (rawStats) stats = JSON.parse(rawStats);
                }
                return new Response(JSON.stringify({ success: true, stats }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (err) {
                return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
            }
        }

        // 2. VLESS WebSocket Traffic Engine
        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader === 'websocket') {
            return await handleVlessStream(request, env, ctx);
        }

        // 3. Masquerade / Cloaking (Reverse Proxy to Ubuntu)
        return handleMasquerade(request);
    }
};

// -----------------------------------------------------------------------------
// VLESS WebSocket Stream Handler
// -----------------------------------------------------------------------------
async function handleVlessStream(request, env, ctx) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();

    let remoteSocketWrapper = null;
    let userUuid = null;
    let totalBytes = 0;

    server.addEventListener('message', async (event) => {
        try {
            if (!remoteSocketWrapper) {
                const buffer = event.data;
                if (buffer.byteLength < 18) return;

                // Extract UUID (Bytes 1 to 17)
                userUuid = stringifyUuid(new Uint8Array(buffer.slice(1, 17)));

                // Authenticate User from KV
                let isAllowed = true;
                if (env.KV) {
                    const rawConfig = await env.KV.get('nahan_config');
                    if (rawConfig) {
                        const conf = JSON.parse(rawConfig);
                        const users = conf.users || [];
                        const matched = users.find(u => (u.uuid || u.id) === userUuid);
                        if (!matched || matched.enabled === false) {
                            isAllowed = false;
                        }
                    }
                }

                if (!isAllowed) {
                    server.close(1008, 'User Disabled or Expired');
                    return;
                }

                // Parse Target Host and Port from VLESS Header
                const view = new DataView(buffer);
                const optLength = view.getUint8(17);
                const command = view.getUint8(18 + optLength); // 1 = TCP Connect
                if (command !== 1) return;

                let offset = 19 + optLength;
                const port = view.getUint16(offset);
                offset += 2;
                const addrType = view.getUint8(offset);
                offset += 1;

                let address = '';
                if (addrType === 1) { // IPv4
                    address = new Uint8Array(buffer.slice(offset, offset + 4)).join('.');
                    offset += 4;
                } else if (addrType === 2) { // Domain
                    const domainLen = view.getUint8(offset);
                    offset += 1;
                    address = new TextDecoder().decode(buffer.slice(offset, offset + domainLen));
                    offset += domainLen;
                } else if (addrType === 3) { // IPv6
                    const ipv6 = [];
                    for (let i = 0; i < 8; i++) {
                        ipv6.push(view.getUint16(offset + i * 2).toString(16));
                    }
                    address = ipv6.join(':');
                    offset += 16;
                }

                // Connect to Target via Cloudflare connect()
                const rawData = buffer.slice(offset);
                const tcpSocket = connect({ hostname: address, port: port });
                remoteSocketWrapper = tcpSocket;

                const writer = tcpSocket.writable.getWriter();
                if (rawData.byteLength > 0) {
                    await writer.write(new Uint8Array(rawData));
                    totalBytes += rawData.byteLength;
                }

                // Pipe WebSocket to TCP
                server.addEventListener('message', async (e) => {
                    try {
                        const chunk = new Uint8Array(e.data);
                        totalBytes += chunk.byteLength;
                        await writer.write(chunk);
                    } catch (err) {}
                });

                // Pipe TCP to WebSocket
                tcpSocket.readable.pipeTo(new WritableStream({
                    write(chunk) {
                        totalBytes += chunk.byteLength;
                        server.send(chunk);
                    },
                    close() {
                        server.close();
                        recordUsage(env, ctx, userUuid, totalBytes);
                    },
                    abort() {
                        server.close();
                        recordUsage(env, ctx, userUuid, totalBytes);
                    }
                })).catch(() => {});

                // VLESS Response Header (0x00, 0x00)
                server.send(new Uint8Array([0, 0]));
            }
        } catch (err) {
            server.close();
        }
    });

    server.addEventListener('close', () => {
        if (remoteSocketWrapper) {
            try { remoteSocketWrapper.close(); } catch(e){}
        }
        recordUsage(env, ctx, userUuid, totalBytes);
    });

    return new Response(null, { status: 101, webSocket: client });
}

// Record User Traffic to KV
function recordUsage(env, ctx, uuid, bytes) {
    if (!uuid || !bytes || !env.KV) return;
    ctx.waitUntil((async () => {
        try {
            const raw = await env.KV.get('agent_user_stats');
            const stats = raw ? JSON.parse(raw) : {};
            stats[uuid] = (stats[uuid] || 0) + bytes;
            await env.KV.put('agent_user_stats', JSON.stringify(stats));
        } catch (e) {}
    })());
}

// Convert Array to UUID String
function stringifyUuid(arr) {
    const hex = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Masquerade to Ubuntu Official Site
async function handleMasquerade(request) {
    const targetUrl = new URL(request.url);
    targetUrl.hostname = 'ubuntu.com';
    targetUrl.protocol = 'https:';

    const reqHeaders = new Headers(request.headers);
    reqHeaders.set('Host', 'ubuntu.com');
    reqHeaders.set('Referer', 'https://ubuntu.com/');

    const response = await fetch(new Request(targetUrl.toString(), {
        method: request.method,
        headers: reqHeaders,
        body: request.body
    }));

    return response;
}
