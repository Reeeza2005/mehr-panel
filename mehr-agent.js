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
    if (shaPass !== receivedHash) throw new Error("Unauthorized Trojan password");

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

async function establishRemoteSocket(address, port, rawPayload, ws, responseHeader, proxyList) {
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

    const pipeSink = new WritableStream({
        async write(chunk) {
            if (remoteSocket) {
                const writer = remoteSocket.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const header = parseVlessHeader(chunk);
            const respHeader = new Uint8Array([header.version[0], 0]);
            remoteSocket = await establishRemoteSocket(
                header.address,
                header.port,
                header.rawData,
                serverWs,
                respHeader,
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

    const pipeSink = new WritableStream({
        async write(chunk) {
            if (remoteSocket) {
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
        return new Response("Not Found", { status: 404 });
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.headers.get("Upgrade") === "websocket") {
            if (path.startsWith("/vl")) return handleVlessWS(request, env);
            if (path.startsWith("/tr")) return handleTrojanWS(request, env);
            return new Response("Not Found", { status: 404 });
        }

        if (path === "/api/status") {
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
