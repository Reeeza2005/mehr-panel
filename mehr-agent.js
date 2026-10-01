import { connect } from "cloudflare:sockets";

const DEFAULT_PROXY_IP = "134.209.136.197";

var cachedAllowedUsers = new Set();
var cachedBlockedUsers = new Set();
var lastSyncTime = 0;
var pendingRequestsCount = 0;
var pendingUserTraffic = new Map();
var detectedCountry = "";

// همگام‌‌سازی سبک با پنل مستر بدون اختلال در ترافیک
async function syncWithMaster(env, request) {
  try {
    if (request?.cf?.country) {
      detectedCountry = request.cf.country;
    }
    const now = Date.now();
    if (now - lastSyncTime < 25000 && pendingRequestsCount < 15) {
      return;
    }

    const panelUrl = env.PANEL_URL;
    const nodeKey = env.API_KEY || env.CLUSTER_KEY;
    if (!panelUrl || !nodeKey) return;

    const reqsToSend = pendingRequestsCount > 0 ? pendingRequestsCount : 1;
    const trafficSnapshot = [];
    for (const [uuid, tr] of pendingUserTraffic.entries()) {
      if (tr.up > 0 || tr.down > 0) {
        trafficSnapshot.push({ uuid, up: Number(tr.up) || 0, down: Number(tr.down) || 0 });
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(`${panelUrl.replace(/\/+$/, "")}/api/node/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Node-Key": nodeKey,
        "Authorization": `Bearer ${nodeKey}`
      },
      body: JSON.stringify({
        node_id: env.NODE_ID || "nod-4",
        timestamp: now,
        requests_count: reqsToSend,
        requests_delta: reqsToSend,
        requests: reqsToSend,
        country: detectedCountry || "XX",
        user_traffic: trafficSnapshot
      }),
      signal: controller.signal
    }).catch(() => null);

    clearTimeout(timer);

    if (res && res.ok) {
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

      const data = await res.json().catch(() => null);
      if (data) {
        if (Array.isArray(data.allowed_uuids)) {
          cachedAllowedUsers = new Set(data.allowed_uuids.map(x => String(x).toLowerCase()));
        }
        if (Array.isArray(data.blocked_uuids)) {
          cachedBlockedUsers = new Set(data.blocked_uuids.map(x => String(x).toLowerCase()));
        }
      }
    }
  } catch (e) {}
}

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
  if (!header) return { earlyData: null, error: null };
  try {
    const clean = header.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(clean);
    return { earlyData: Uint8Array.from(binary, c => c.charCodeAt(0)).buffer, error: null };
  } catch (e) {
    return { earlyData: null, error: e };
  }
}

function safeCloseWebSocket(ws) {
  try {
    if (ws.readyState === 1 || ws.readyState === 2) ws.close();
  } catch (e) {}
}

function makeWebSocketReadableStream(ws, earlyDataHeader) {
  let isClosed = false;
  return new ReadableStream({
    start(controller) {
      ws.addEventListener("message", async e => {
        if (!isClosed) {
          let data = e.data;
          if (data instanceof Blob) {
            data = await data.arrayBuffer();
          }
          controller.enqueue(data);
        }
      });
      ws.addEventListener("close", () => {
        safeCloseWebSocket(ws);
        if (!isClosed) controller.close();
      });
      ws.addEventListener("error", err => {
        if (!isClosed) controller.error(err);
      });
      const { earlyData, error } = parseEarlyData(earlyDataHeader);
      if (error) controller.error(error);
      else if (earlyData) controller.enqueue(earlyData);
    },
    cancel() {
      isClosed = true;
      safeCloseWebSocket(ws);
    }
  });
}

function parseVlessHeader(buffer) {
  let ab = buffer;
  if (buffer instanceof Uint8Array || ArrayBuffer.isView(buffer)) {
    ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  if (ab.byteLength < 24) return { hasError: true, message: "invalid data" };

  const view = new DataView(ab);
  const version = new Uint8Array(ab.slice(0, 1));
  const rawUuid = stringifyUUID(new Uint8Array(ab.slice(1, 17)));
  const cleanUuid = String(rawUuid).toLowerCase();

  if (cachedBlockedUsers.size > 0 && cachedBlockedUsers.has(cleanUuid)) {
    return { hasError: true, message: "user blocked" };
  }

  const optLen = new Uint8Array(ab.slice(17, 18))[0];
  const cmd = new Uint8Array(ab.slice(18 + optLen, 18 + optLen + 1))[0];
  const isUDP = cmd === 2;
  const portIdx = 18 + optLen + 1;
  const port = view.getUint16(portIdx);
  const addrIdx = portIdx + 2;
  const addrType = new Uint8Array(ab.slice(addrIdx, addrIdx + 1))[0];
  let offset = addrIdx + 1;
  let address = "";

  if (addrType === 1) {
    address = new Uint8Array(ab.slice(offset, offset + 4)).join(".");
    offset += 4;
  } else if (addrType === 2) {
    const domainLen = new Uint8Array(ab.slice(offset, offset + 1))[0];
    offset += 1;
    address = new TextDecoder().decode(ab.slice(offset, offset + domainLen));
    offset += domainLen;
  } else if (addrType === 3) {
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(view.getUint16(offset + (i * 2)).toString(16));
    address = parts.join(":");
    offset += 16;
  } else {
    return { hasError: true, message: "invalid address type" };
  }

  return {
    hasError: false,
    uuid: cleanUuid,
    addressRemote: address,
    portRemote: port,
    rawDataIndex: offset,
    VLVersion: version,
    isUDP,
    rawBuffer: ab
  };
}

async function establishSocketWithProxy(socketHolder, targetHost, targetPort, rawPayload, ws, responseHeader, userUuid, env) {
  let sock = null;
  const proxyIP = env?.PROXY_IP || DEFAULT_PROXY_IP;

  // مرحله ۱: تلاش اول برای اتصال مستقیم به هاست واقعی (ضروری برای تست پینگ کلاینت)
  try {
    sock = connect({ hostname: targetHost, port: targetPort });
    socketHolder.value = sock;

    if (rawPayload && rawPayload.byteLength > 0) {
      const writer = sock.writable.getWriter();
      await writer.write(rawPayload);
      writer.releaseLock();
    }
  } catch (directErr) {
    // مرحله ۲: سوییچ خودکار به Proxy IP در صورت مسدود بودن اتصال مستقیم
    try {
      if (proxyIP) {
        sock = connect({ hostname: proxyIP, port: targetPort === 443 ? 443 : 80 });
        socketHolder.value = sock;
        if (rawPayload && rawPayload.byteLength > 0) {
          const writer = sock.writable.getWriter();
          await writer.write(rawPayload);
          writer.releaseLock();
        }
      } else {
        throw directErr;
      }
    } catch (proxyErr) {
      safeCloseWebSocket(ws);
      return;
    }
  }

  let headerToSend = responseHeader;
  const wsWriter = new WritableStream({
    async write(chunk) {
      if (ws.readyState !== 1) return;
      const sz = chunk.byteLength || chunk.length || 0;
      if (userUuid && sz > 0) {
        const uStat = pendingUserTraffic.get(userUuid) || { up: 0, down: 0 };
        uStat.down += sz;
        pendingUserTraffic.set(userUuid, uStat);
      }

      if (headerToSend) {
        ws.send(await new Blob([headerToSend, chunk]).arrayBuffer());
        headerToSend = null;
      } else {
        ws.send(chunk);
      }
    },
    close() { try { sock.close(); } catch {} },
    abort() { try { sock.close(); } catch {} }
  });

  sock.readable.pipeTo(wsWriter).catch(() => {
    try { sock.close(); } catch {}
    safeCloseWebSocket(ws);
  });
}

function handleVlessWS(request, env) {
  const pair = new WebSocketPair();
  const [clientWs, serverWs] = Object.values(pair);
  serverWs.accept();

  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
  const readableStream = makeWebSocketReadableStream(serverWs, earlyDataHeader);

  let socketHolder = { value: null };
  let currentUserUuid = null;

  const writableStream = new WritableStream({
    async write(chunk) {
      if (socketHolder.value) {
        const sz = chunk.byteLength || chunk.length || 0;
        if (currentUserUuid && sz > 0) {
          const uStat = pendingUserTraffic.get(currentUserUuid) || { up: 0, down: 0 };
          uStat.up += sz;
          pendingUserTraffic.set(currentUserUuid, uStat);
        }
        const writer = socketHolder.value.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }

      const parsed = parseVlessHeader(chunk);
      if (parsed.hasError) {
        safeCloseWebSocket(serverWs);
        return;
      }

      currentUserUuid = parsed.uuid;
      const vlessResponseHeader = new Uint8Array([parsed.VLVersion[0], 0]);
      const rawPayload = parsed.rawBuffer.slice(parsed.rawDataIndex);

      if (rawPayload && rawPayload.byteLength > 0 && currentUserUuid) {
        const uStat = pendingUserTraffic.get(currentUserUuid) || { up: 0, down: 0 };
        uStat.up += rawPayload.byteLength;
        pendingUserTraffic.set(currentUserUuid, uStat);
      }

      await establishSocketWithProxy(
        socketHolder,
        parsed.addressRemote,
        parsed.portRemote,
        rawPayload,
        serverWs,
        vlessResponseHeader,
        currentUserUuid,
        env
      );
    },
    close() {
      if (socketHolder.value) try { socketHolder.value.close(); } catch {}
    }
  });

  readableStream.pipeTo(writableStream).catch(() => {
    if (socketHolder.value) try { socketHolder.value.close(); } catch {}
    safeCloseWebSocket(serverWs);
  });

  return new Response(null, { status: 101, webSocket: clientWs });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.toLowerCase();
    const upgradeHeader = request.headers.get("Upgrade") || request.headers.get("upgrade") || "";
    const isWebSocket = upgradeHeader.toLowerCase() === "websocket";

    if (isWebSocket) {
      pendingRequestsCount++;
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(syncWithMaster(env, request).catch(() => {}));
      }
      return handleVlessWS(request, env);
    }

    if (path === "/vl" || path.startsWith("/vl/") || path === "/vless") {
      return new Response("VLESS WebSocket Endpoint - Awaiting Upgrade", {
        status: 426,
        headers: { "Upgrade": "websocket" }
      });
    }

    if (path === "/api/status" || path === "/api/stats") {
      return new Response(JSON.stringify({
        status: "active",
        role: "edge_node",
        node_id: env.NODE_ID || "nod-4"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Service Available", { status: 200 });
  }
};
