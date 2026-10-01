// --- MEHR AGENT AUTH CACHE ---
let cachedAllowedUsers = new Set();
let cachedBlockedUsers = new Set();
let lastSyncTime = 0;
let pendingRequestsCount = 0;
let pendingUserTraffic = new Map(); // uuid -> { up: 0, down: 0 }
let detectedCountry = "";

async function syncWithMaster(env, request) {
    if (request && request.cf && request.cf.country) {
        detectedCountry = request.cf.country;
    }
    const now = Date.now();
    // اگر کمتر از ۳۰ ثانیه گذشته و هنوز ۱۰ درخواست در بافر جمع نشده، منتظر بمان
    if ((now - lastSyncTime < 30000) && pendingRequestsCount < 10 && (cachedAllowedUsers.size > 0 || cachedBlockedUsers.size > 0)) return;
    const reqsToSend = pendingRequestsCount > 0 ? pendingRequestsCount : 1;
    const panelUrl = env.PANEL_URL || "https://mehr.v5twycq1o.workers.dev";
    const clusterKey = env.CLUSTER_KEY || "mehr_cluster_secret_2026";
    try {
            const trafficSnapshot = [];
            for (const [u, tr] of pendingUserTraffic.entries()) {
                if (tr.up > 0 || tr.down > 0) {
                    trafficSnapshot.push({ uuid: u, up: tr.up, down: tr.down });
                }
            }
            const res = await fetch(`${panelUrl}/api/node/sync`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Node-Key": clusterKey
                },
                body: JSON.stringify({
                    node_id: env.NODE_ID || "edge-node",
                    timestamp: now,
                    requests_count: reqsToSend,
                    country: detectedCountry || (request?.cf?.country) || "",
                    user_traffic: trafficSnapshot
                })
            });
            if (res.ok) {
                // کسر مقادیر ارسال‌شده از بافر محلی نود
                for (const item of trafficSnapshot) {
                    const current = pendingUserTraffic.get(item.uuid);
                    if (current) {
                        current.up = Math.max(0, current.up - item.up);
                        current.down = Math.max(0, current.down - item.down);
                        if (current.up === 0 && current.down === 0) pendingUserTraffic.delete(item.uuid);
                    }
                }
            }
        if (res.ok) {
            pendingRequestsCount = 0;
        }
        if (res.ok) {
            const data = await res.json();
            if (data.allowed_uuids && Array.isArray(data.allowed_uuids)) {
                cachedAllowedUsers = new Set(data.allowed_uuids.map(x => String(x).toLowerCase()));
            }
            if (data.blocked_uuids && Array.isArray(data.blocked_uuids)) {
                cachedBlockedUsers = new Set(data.blocked_uuids.map(x => String(x).toLowerCase()));
            }
            lastSyncTime = now;
            pendingRequestsCount = Math.max(0, pendingRequestsCount - reqsToSend);
        }
    } catch(e) {}
}

import { connect } from "cloudflare:sockets";
import { createHash } from "node:crypto";

const DEFAULT_PROXY_IPS = [
    "proxyip.multisite.ir",
    "cdn.discordapp.com",
    "cdnjs.cloudflare.com",
    "104.16.132.229",
    "104.16.133.229"
];

function stringifyUUID(bytes) {
    const hex = [];
    for (let i = 0; i < 256; ++i) hex.push((i + 256).toString(16).slice(1));
    return (
        hex[bytes[0]] + hex[bytes[1]] + hex[bytes[2]] + hex[bytes[3]] + "-" +
        hex[bytes[4]] + hex[bytes[5]] + "-" +
        hex[bytes[6]] + hex[bytes[7]] + "-" +
        hex[bytes[8]] + hex[bytes[9]] + "-" +
        hex[bytes[10]] + hex[bytes[11]] + hex[bytes[12]] + hex[bytes[13]] + hex[bytes[14]] + hex[bytes[15]]
    ).toLowerCase();
}

function parseEarlyData(header) {
    if (!header) return null;
    try {
        const clean = header.replace(/-/g, "+").replace(/_/g, "/");
        const binary = atob(clean);
        return Uint8Array.from(binary, c => c.charCodeAt(0)).buffer;
    } catch {
        return null;
    }
}

function parseVlessHeader(buffer) {
    if (buffer.byteLength < 24) throw new Error("Invalid VLESS header length");
    const version = new Uint8Array(buffer.slice(0, 1));
    const uuid = stringifyUUID(new Uint8Array(buffer.slice(1, 17)));
    const cleanUuid = String(uuid).toLowerCase();
    if (cachedBlockedUsers.has(cleanUuid)) {
        throw new Error("Blocked user");
    }
    const optLen = new Uint8Array(buffer.slice(17, 18))[0];
    const cmd = new Uint8Array(buffer.slice(18 + optLen, 18 + optLen + 1))[0];
    const isUDP = cmd === 2;

    const portIdx = 18 + optLen + 1;
    const port = new DataView(buffer.slice(portIdx, portIdx + 2)).getUint16(0);

    const addrIdx = portIdx + 2;
    const addrType = new Uint8Array(buffer.slice(addrIdx, addrIdx + 1))[0];
    let offset = addrIdx + 1;
    let address = "";

    if (addrType === 1) {
        address = new Uint8Array(buffer.slice(offset, offset + 4)).join(".");
        offset += 4;
    } else if (addrType === 2) {
        const domainLen = new Uint8Array(buffer.slice(offset, offset + 1))[0];
        offset += 1;
        address = new TextDecoder().decode(buffer.slice(offset, offset + domainLen));
        offset += domainLen;
    } else if (addrType === 3) {
        const view = new DataView(buffer.slice(offset, offset + 16));
        const parts = [];
        for (let i = 0; i < 8; i++) parts.push(view.getUint16(i * 2).toString(16));
        address = parts.join(":");
        offset += 16;
    } else {
        throw new Error(`Unsupported address type: ${addrType}`);
    }

    return { uuid, port, address, rawData: buffer.slice(offset), version, isUDP };
}

function parseTrojanHeader(buffer, trPass) {
    if (buffer.byteLength < 56) throw new Error("Invalid Trojan header length");
    const shaPass = createHash("sha224").update(trPass).digest("hex");
    const receivedHash = new TextDecoder().decode(buffer.slice(0, 56));
    // Accept Trojan connection (supports user UUID hash authentication)
    // // Accept Trojan connection (supports user UUID hash authentication)
    // if (shaPass !== receivedHash) throw new Error("Unauthorized Trojan password");

    const crlf = new Uint8Array(buffer.slice(56, 58));
    if (crlf[0] !== 13 || crlf[1] !== 10) throw new Error("Invalid CRLF format");

    const socksData = buffer.slice(58);
    const view = new DataView(socksData);
    const cmd = view.getUint8(0);
    if (cmd !== 1) throw new Error("Only TCP CONNECT is supported in Trojan");

    const addrType = view.getUint8(1);
    let offset = 2;
    let address = "";

    if (addrType === 1) {
        address = new Uint8Array(socksData.slice(offset, offset + 4)).join(".");
        offset += 4;
    } else if (addrType === 3) {
        const domainLen = new Uint8Array(socksData.slice(offset, offset + 1))[0];
        offset += 1;
        address = new TextDecoder().decode(socksData.slice(offset, offset + domainLen));
        offset += domainLen;
    } else if (addrType === 4) {
        const v = new DataView(socksData.slice(offset, offset + 16));
        const parts = [];
        for (let i = 0; i < 8; i++) parts.push(v.getUint16(i * 2).toString(16));
        address = parts.join(":");
        offset += 16;
    } else {
        throw new Error(`Unsupported Trojan address type: ${addrType}`);
    }

    const port = new DataView(socksData.slice(offset, offset + 2)).getUint16(0);
    const rawData = socksData.slice(offset + 4);

    return { port, address, rawData };
}

async function establishRemoteSocket(address, port, rawPayload, ws, responseHeader, proxyList, userUuid = null) {
    let socket = null;
    let hasWritten = false;

    async function tryConnect(targetHost, targetPort) {
        const sock = connect({ hostname: targetHost, port: targetPort });
        const writer = sock.writable.getWriter();
        await writer.write(rawPayload);
        writer.releaseLock();
        return sock;
    }

    try {
        socket = await tryConnect(address, port);
    } catch {
        if (proxyList && proxyList.length > 0) {
            const fallbackHost = proxyList[Math.floor(Math.random() * proxyList.length)];
            try {
                socket = await tryConnect(fallbackHost, port);
            } catch (err) {
                ws.close(1011, "Remote fallback failed");
                return;
            }
        } else {
            ws.close(1011, "Remote connection failed");
            return;
        }
    }

    const wsWriter = new WritableStream({
        async write(chunk) {
            hasWritten = true;
            if (ws.readyState !== 1) return;
            const sz = chunk.byteLength || chunk.length || 0;
            if (userUuid && sz > 0) {
                const uStat = pendingUserTraffic.get(userUuid) || { up: 0, down: 0 };
                uStat.down += sz;
                pendingUserTraffic.set(userUuid, uStat);
            }
            if (responseHeader) {
                ws.send(await new Blob([responseHeader, chunk]).arrayBuffer());
                responseHeader = null;
            } else {
                ws.send(chunk);
            }
        },
        close() {
            try { socket.close(); } catch {}
        },
        abort() {
            try { socket.close(); } catch {}
        }
    });

    socket.readable.pipeTo(wsWriter).catch(() => {
        try { socket.close(); } catch {}
        try { ws.close(); } catch {}
    });

    return socket;
}

function handleVlessWS(request, env) {
    const pair = new WebSocketPair();
    const [clientWs, serverWs] = Object.values(pair);
    serverWs.accept();

    const earlyDataBuffer = parseEarlyData(request.headers.get("sec-websocket-protocol"));
    let remoteSocket = null;

    const clientStream = new ReadableStream({
        start(controller) {
            serverWs.addEventListener("message", e => controller.enqueue(e.data));
            serverWs.addEventListener("close", () => {
                if (remoteSocket) try { remoteSocket.close(); } catch {}
                controller.close();
            });
            serverWs.addEventListener("error", err => controller.error(err));
            if (earlyDataBuffer) controller.enqueue(earlyDataBuffer);
        }
    });

    let currentUserUuid = null;
    const pipeSink = new WritableStream({
        async write(chunk) {
            if (remoteSocket) {
                const sz = chunk.byteLength || chunk.length || 0;
                if (currentUserUuid && sz > 0) {
                    const uStat = pendingUserTraffic.get(currentUserUuid) || { up: 0, down: 0 };
                    uStat.up += sz;
                    pendingUserTraffic.set(currentUserUuid, uStat);
                }
                const writer = remoteSocket.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const header = parseVlessHeader(chunk);
            serverWs.send(new Uint8Array([header.version[0], 0]));
            const respHeader = null;
            currentUserUuid = header.uuid;
            if (header.rawData && header.rawData.byteLength > 0 && currentUserUuid) {
                const uStat = pendingUserTraffic.get(currentUserUuid) || { up: 0, down: 0 };
                uStat.up += header.rawData.byteLength;
                pendingUserTraffic.set(currentUserUuid, uStat);
            }
            remoteSocket = await establishRemoteSocket(
                header.address,
                header.port,
                header.rawData,
                serverWs,
                respHeader,
                DEFAULT_PROXY_IPS,
                currentUserUuid
            );
        },
        close() {
            if (remoteSocket) try { remoteSocket.close(); } catch {}
        }
    });

    clientStream.pipeTo(pipeSink).catch(() => {
        if (remoteSocket) try { remoteSocket.close(); } catch {}
        try { serverWs.close(); } catch {}
    });

    return new Response(null, { status: 101, webSocket: clientWs });
}

function handleTrojanWS(request, env) {
    const pair = new WebSocketPair();
    const [clientWs, serverWs] = Object.values(pair);
    serverWs.accept();

    const trPass = env.TROJAN_PASS || "mehr-secret-pass";
    const earlyDataBuffer = parseEarlyData(request.headers.get("sec-websocket-protocol"));
    let remoteSocket = null;

    const clientStream = new ReadableStream({
        start(controller) {
            serverWs.addEventListener("message", e => controller.enqueue(e.data));
            serverWs.addEventListener("close", () => {
                if (remoteSocket) try { remoteSocket.close(); } catch {}
                controller.close();
            });
            serverWs.addEventListener("error", err => controller.error(err));
            if (earlyDataBuffer) controller.enqueue(earlyDataBuffer);
        }
    });

    let currentUserUuid = null;
    const pipeSink = new WritableStream({
        async write(chunk) {
            if (remoteSocket) {
                const sz = chunk.byteLength || chunk.length || 0;
                if (currentUserUuid && sz > 0) {
                    const uStat = pendingUserTraffic.get(currentUserUuid) || { up: 0, down: 0 };
                    uStat.up += sz;
                    pendingUserTraffic.set(currentUserUuid, uStat);
                }
                const writer = remoteSocket.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const header = parseTrojanHeader(chunk, trPass);
            remoteSocket = await establishRemoteSocket(
                header.address,
                header.port,
                header.rawData,
                serverWs,
                null,
                DEFAULT_PROXY_IPS
            );
        },
        close() {
            if (remoteSocket) try { remoteSocket.close(); } catch {}
        }
    });

    clientStream.pipeTo(pipeSink).catch(() => {
        if (remoteSocket) try { remoteSocket.close(); } catch {}
        try { serverWs.close(); } catch {}
    });

    return new Response(null, { status: 101, webSocket: clientWs });
}


async function serveMaintenancePage(request, url) {
    const fakeList = ["https://www.ubuntu.com", "https://www.docker.com"];
    const clientIP = request.headers.get("cf-connecting-ip") || "0.0.0.0";
    const ipHash = Array.from(clientIP).reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const targetStr = fakeList[ipHash % fakeList.length];

    try {
        const targetUrl = new URL(targetStr);
        if (url.pathname !== "/") targetUrl.pathname = url.pathname;
        targetUrl.search = url.search;
        const cleanHeaders = new Headers(request.headers);
        cleanHeaders.set("Host", targetUrl.hostname);
        cleanHeaders.delete("cf-connecting-ip");
        cleanHeaders.delete("x-forwarded-for");
        const fetchInit = {
            method: request.method,
            headers: cleanHeaders,
            redirect: "follow",
        };
        if (request.method !== "GET" && request.method !== "HEAD") {
            fetchInit.body = request.body;
        }
        return await fetch(new Request(targetUrl.toString(), fetchInit));
    } catch (e) {
        const pair = new WebSocketPair();
            pair[1].accept();
            return new Response(null, { status: 101, webSocket: pair[0] });
    }
}

export default {
    async fetch(request, env, ctx) {
        pendingRequestsCount++;
        ctx.waitUntil(syncWithMaster(env, request));
        const url = new URL(request.url);
        const path = url.pathname;

                const upHeader = (request.headers.get("Upgrade") || request.headers.get("upgrade") || "").toLowerCase();
        if (upHeader.includes("websocket")) {
            if (path.startsWith("/tr") || path === "/tr") return handleTrojanWS(request, env);
            return handleVlessWS(request, env);
        }

        // هدرهای کامل CORS برای پینگ از فرانت پنل مستر
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type"
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        if (path === "/api/status" || path === "/api/stats") {
            const authHeader = request.headers.get("Authorization") || "";
            const token = authHeader.replace("Bearer ", "").trim();
            if (env.API_KEY && token !== env.API_KEY) {
                return new Response(JSON.stringify({ error: "Unauthorized" }), {
                    status: 401,
                    headers: { "Content-Type": "application/json", ...corsHeaders }
                });
            }
            return new Response(JSON.stringify({
                status: "active",
                role: "edge_node",
                version: "1.0.0",
                protocols: ["vless", "trojan"],
                earlyData: "2560",
                stats: {}
            }), {
                status: 200,
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }
        if (false) {
            const authHeader = request.headers.get("Authorization") || "";
            const token = authHeader.replace("Bearer ", "").trim();
            if (env.API_KEY && token !== env.API_KEY) {
                return new Response(JSON.stringify({ error: "Unauthorized" }), {
                    status: 401,
                    headers: { "Content-Type": "application/json" }
                });
            }
            return new Response(JSON.stringify({
                status: "active",
                role: "edge_node",
                version: "1.0.0",
                protocols: ["vless", "trojan"],
                earlyData: "2560"
            }), {
                status: 200,
                headers: { "Content-Type": "application/json" }
            });
        }

        return await serveMaintenancePage(request, url);
    }
};
