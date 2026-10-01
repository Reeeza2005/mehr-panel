import { connect } from "cloudflare:sockets";

var cachedAllowedUsers = new Set();
var cachedBlockedUsers = new Set();
var lastSyncTime = 0;
var totalWorkerRequests = 0;
var pendingRequestsCount = 0;
var pendingUserTraffic = new Map();
var detectedCountry = "";

async function syncWithMaster(env, request) {
  if (request && request.cf && request.cf.country) {
    detectedCountry = request.cf.country;
  }
  const now = Date.now();
  if (now - lastSyncTime < 20000 && pendingRequestsCount < 15 && (cachedAllowedUsers.size > 0 || cachedBlockedUsers.size > 0)) {
    return;
  }

  const panelUrl = env.PANEL_URL;
  const clusterKey = env.CLUSTER_KEY;
  if (!panelUrl || !clusterKey) return;

  const reqsToSend = pendingRequestsCount > 0 ? pendingRequestsCount : 1;
  try {
    const trafficSnapshot = [];
    for (const [uuid, tr] of pendingUserTraffic.entries()) {
      if (tr.up > 0 || tr.down > 0) {
        trafficSnapshot.push({ uuid, up: tr.up, down: tr.down });
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
        country: detectedCountry || request?.cf?.country || "",
        user_traffic: trafficSnapshot
      })
    });

    if (res.ok) {
      for (const item of trafficSnapshot) {
        const cur = pendingUserTraffic.get(item.uuid);
        if (cur) {
          cur.up = Math.max(0, cur.up - item.up);
          cur.down = Math.max(0, cur.down - item.down);
          if (cur.up === 0 && cur.down === 0) pendingUserTraffic.delete(item.uuid);
        }
      }
      pendingRequestsCount = Math.max(0, pendingRequestsCount - reqsToSend);
      lastSyncTime = now;

      const data = await res.json();
      if (Array.isArray(data.allowed_uuids)) {
        cachedAllowedUsers = new Set(data.allowed_uuids.map(x => String(x).toLowerCase()));
      }
      if (Array.isArray(data.blocked_uuids)) {
        cachedBlockedUsers = new Set(data.blocked_uuids.map(x => String(x).toLowerCase()));
      }
    }
  } catch (e) {}
}

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

  if (cachedBlockedUsers.size > 0 && cachedBlockedUsers.has(cleanUuid)) {
    throw new Error("User blocked");
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

  return { uuid: cleanUuid, port, address, rawData: buffer.slice(offset), version, isUDP };
}

async function establishRemoteSocket(address, port, rawPayload, ws, initialResponseHeader, proxyList, userUuid) {
  async function connectTarget(host, targetPort) {
    const sock = connect({ hostname: host, port: targetPort });
    if (rawPayload && rawPayload.byteLength > 0) {
      const writer = sock.writable.getWriter();
      await writer.write(rawPayload);
      writer.releaseLock();
    }
    return sock;
  }

  let socket = null;
  try {
    socket = await connectTarget(address, port);
  } catch (err) {
    if (proxyList && proxyList.length > 0) {
      const fallbackHost = proxyList[Math.floor(Math.random() * proxyList.length)];
      try {
        socket = await connectTarget(fallbackHost, port);
      } catch (fErr) {
        try { ws.close(1011, "Remote fallback unreachable"); } catch {}
        return null;
      }
    } else {
      try { ws.close(1011, "Remote target unreachable"); } catch {}
      return null;
    }
  }

  let sentRespHeader = !initialResponseHeader;
  const wsWriter = new WritableStream({
    async write(chunk) {
      if (ws.readyState !== 1) return;
      const sz = chunk.byteLength || chunk.length || 0;
      if (userUuid && sz > 0) {
        const uStat = pendingUserTraffic.get(userUuid) || { up: 0, down: 0 };
        uStat.down += sz;
        pendingUserTraffic.set(userUuid, uStat);
      }

      if (!sentRespHeader && initialResponseHeader) {
        const combined = new Uint8Array(initialResponseHeader.byteLength + (chunk.byteLength || chunk.length || 0));
        combined.set(new Uint8Array(initialResponseHeader), 0);
        combined.set(new Uint8Array(chunk), initialResponseHeader.byteLength);
        ws.send(combined.buffer);
        sentRespHeader = true;
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

  const earlyData = parseEarlyData(request.headers.get("sec-websocket-protocol"));
  let remoteSocket = null;
  let currentUserUuid = null;

  const clientStream = new ReadableStream({
    start(controller) {
      serverWs.addEventListener("message", e => controller.enqueue(e.data));
      serverWs.addEventListener("close", () => {
        if (remoteSocket) try { remoteSocket.close(); } catch {}
        controller.close();
      });
      serverWs.addEventListener("error", err => controller.error(err));
      if (earlyData) controller.enqueue(earlyData);
    }
  });

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
      currentUserUuid = header.uuid;

      if (header.rawData && header.rawData.byteLength > 0 && currentUserUuid) {
        const uStat = pendingUserTraffic.get(currentUserUuid) || { up: 0, down: 0 };
        uStat.up += header.rawData.byteLength;
        pendingUserTraffic.set(currentUserUuid, uStat);
      }

      const vlessResponseHeader = new Uint8Array([header.version[0], 0]);

      remoteSocket = await establishRemoteSocket(
        header.address,
        header.port,
        header.rawData,
        serverWs,
        vlessResponseHeader,
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
      redirect: "follow"
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      fetchInit.body = request.body;
    }
    return await fetch(new Request(targetUrl.toString(), fetchInit));
  } catch (e) {
    return new Response("Service Unavailable", { status: 503 });
  }
}

export default {
  async fetch(request, env, ctx) {
    totalWorkerRequests++;
    pendingRequestsCount++;
    ctx.waitUntil(syncWithMaster(env, request));

    const url = new URL(request.url);
    const path = url.pathname.toLowerCase();
    const upgradeHeader = (request.headers.get("Upgrade") || "").toLowerCase();

    if (upgradeHeader === "websocket") {
      if (path === "/" || path.startsWith("/vl") || path.includes("vless")) {
        return handleVlessWS(request, env);
      }
      return new Response("WebSocket Protocol Mismatch", { status: 400 });
    }

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
        version: "2.1.0",
        node_id: env.NODE_ID || "unknown",
        country: detectedCountry || request.cf?.country || "XX",
        total_requests: totalWorkerRequests,
        pending_traffic_users: pendingUserTraffic.size
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    return await serveMaintenancePage(request, url);
  }
};
