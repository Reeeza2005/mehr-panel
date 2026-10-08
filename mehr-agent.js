// =============================================================================
// Mehr Lightweight Edge Agent (BPB-Pattern Architecture - Stable Core)
// =============================================================================

let connectSocket = null;
try {
    const sockets = await import("cloudflare:sockets");
    connectSocket = sockets.connect;
} catch (e) {
    // در صورت عدم دسترسی در محیط تست یا قدیمی
}

let dynamicConfig = {
    proxyIP: "",
    chainingEnabled: false,
    upstreamHost: "",
    upstreamPort: 0,
    blockedDomains: []
};

export default {
    async fetch(request, env, ctx) {
        try {
            const url = new URL(request.url);

            // ۱. اندپوینت‌های مدیریتی پنل مستر
            if (url.pathname.startsWith("/api/")) {
                return await handleManagementApi(request, env);
            }

            // ۲. بررسی درخواست وب‌سوکت ترافیک
            const upgradeHeader = request.headers.get("Upgrade");
            if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
                return await handleTrafficStream(request, env);
            }

            // ۳. پاسخ لندینگ پیش‌فرض
            return new Response(JSON.stringify({
                status: "active",
                node_id: env.NODE_ID || "edge-node",
                engine: "mehr-agent-bpb",
                version: "1.0.0"
            }, null, 2), {
                headers: { "Content-Type": "application/json; charset=utf-8" }
            });
        } catch (err) {
            return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
                status: 500,
                headers: { "Content-Type": "application/json" }
            });
        }
    }
};

// -----------------------------------------------------------------------------
// مدیریت API پنل مستر
// -----------------------------------------------------------------------------
async function handleManagementApi(request, env) {
    const authHeader = request.headers.get("Authorization");
    const expectedKey = env.API_KEY;

    if (!authHeader || authHeader !== `Bearer ${expectedKey}`) {
        return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
        });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/status" && request.method === "GET") {
        return new Response(JSON.stringify({
            success: true,
            node_id: env.NODE_ID || "edge-node",
            status: "online",
            config: dynamicConfig,
            timestamp: Date.now()
        }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api/stats" && request.method === "GET") {
        return new Response(JSON.stringify({
            success: true,
            stats: { requests_today: 0, status: "ready" }
        }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api/config" && request.method === "POST") {
        try {
            const body = await request.json();
            dynamicConfig = { ...dynamicConfig, ...body };
            return new Response(JSON.stringify({
                success: true,
                message: "Configuration updated successfully",
                currentConfig: dynamicConfig
            }), { headers: { "Content-Type": "application/json" } });
        } catch (e) {
            return new Response(JSON.stringify({ success: false, message: e.message }), {
                status: 400,
                headers: { "Content-Type": "application/json" }
            });
        }
    }

    return new Response(JSON.stringify({ success: false, message: "Endpoint not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
    });
}

// -----------------------------------------------------------------------------
// موتور پردازش ترافیک (WebSocket Stream)
// -----------------------------------------------------------------------------
async function handleTrafficStream(request, env) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();

    let remoteSocket = null;
    let isHeaderProcessed = false;

    server.addEventListener("message", async (event) => {
        try {
            const rawData = event.data;

            if (!isHeaderProcessed) {
                const parsed = parseInitialHeader(new Uint8Array(rawData));
                if (!parsed) {
                    server.close(1008, "Invalid protocol header");
                    return;
                }

                let targetAddress = dynamicConfig.proxyIP || parsed.address;
                let targetPort = parsed.port;

                if (!connectSocket) {
                    const sockets = await import("cloudflare:sockets");
                    connectSocket = sockets.connect;
                }

                remoteSocket = connectSocket({
                    hostname: targetAddress,
                    port: targetPort
                });

                if (parsed.payload && parsed.payload.length > 0) {
                    const writer = remoteSocket.writable.getWriter();
                    await writer.write(parsed.payload);
                    writer.releaseLock();
                }

                pipeRemoteToWebSocket(remoteSocket, server);
                isHeaderProcessed = true;
            } else if (remoteSocket) {
                const writer = remoteSocket.writable.getWriter();
                await writer.write(new Uint8Array(rawData));
                writer.releaseLock();
            }
        } catch (err) {
            server.close(1011, err.message);
        }
    });

    server.addEventListener("close", () => {
        if (remoteSocket) remoteSocket.close();
    });

    server.addEventListener("error", () => {
        if (remoteSocket) remoteSocket.close();
    });

    return new Response(null, {
        status: 101,
        webSocket: client
    });
}

function parseInitialHeader(buffer) {
    if (buffer.length < 24) return null;
    const version = buffer[0];
    if (version === 0) {
        let optLength = buffer[17];
        let cursor = 18 + optLength;
        const command = buffer[cursor];
        if (command !== 1) return null;
        cursor++;

        const port = (buffer[cursor] << 8) | buffer[cursor + 1];
        cursor += 2;

        const addressType = buffer[cursor];
        cursor++;

        let address = "";
        if (addressType === 1) {
            address = `${buffer[cursor]}.${buffer[cursor+1]}.${buffer[cursor+2]}.${buffer[cursor+3]}`;
            cursor += 4;
        } else if (addressType === 2) {
            const domainLength = buffer[cursor];
            cursor++;
            address = new TextDecoder().decode(buffer.subarray(cursor, cursor + domainLength));
            cursor += domainLength;
        } else if (addressType === 3) {
            const parts = [];
            for (let i = 0; i < 16; i += 2) {
                parts.push(((buffer[cursor + i] << 8) | buffer[cursor + i + 1]).toString(16));
            }
            address = parts.join(":");
            cursor += 16;
        }

        return { protocol: "vless", address, port, payload: buffer.subarray(cursor) };
    }
    return null;
}

async function pipeRemoteToWebSocket(socket, ws) {
    const reader = socket.readable.getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(value);
            }
        }
    } catch (e) {
    } finally {
        reader.releaseLock();
        if (ws.readyState === WebSocket.OPEN) ws.close();
    }
}
