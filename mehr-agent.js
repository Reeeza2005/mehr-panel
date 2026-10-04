let activeUpstreamTarget = null;
async function getEdgeNodeCFUsage(env) {
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CF_API_TOKEN;
  if (!accountId || !apiToken) return null;
  try {
    const currentDate = new Date().toISOString().split("T")[0] + "T00:00:00Z";
    const query = `query GetDailyUsage($accountId: String!, $start: ISO8601DateTime!) {
      viewer {
        accounts(filter: {accountTag: $accountId}) {
          workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $start }) {
            sum { requests }
          }
        }
      }
    }`;
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables: { accountId, start: currentDate } })
    });
    if (!res.ok) return null;
    const j = await res.json();
    const records = j?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
    let total = 0;
    records.forEach(r => { total += (r?.sum?.requests || 0); });
    return total;
  } catch(e) {
    return null;
  }
}

import { connect } from "cloudflare:sockets";

const DEFAULT_PROXY_IP = "134.209.136.197";

var cachedAllowedUsers = new Set();
var cachedBlockedUsers = new Set();
var lastSyncTime = 0;
var pendingRequestsCount = 0;
var pendingUserTraffic = new Map();
var detectedCountry = "";

// همگام‌‌سازی زنده با پنل مستر
async function syncWithMaster(env, request, force = false) {
  try {
    if (request?.cf?.country) {
      detectedCountry = request.cf.country;
    }
    const now = Date.now();

    // محاسبه کل ترافیک انباشته
    let totalPendingBytes = 0;
    for (const tr of pendingUserTraffic.values()) {
      totalPendingBytes += (tr.up || 0) + (tr.down || 0);
    }

    // اگر اجباری نباشد، زمان کم باشد و دیتای محسوسی نیامده باشد، خارج شو
    if (!force && (now - lastSyncTime < 15000) && totalPendingBytes < 1048576 && pendingRequestsCount < 5) {
      return;
    }

    let panelUrl = (env.PANEL_URL || "").trim();
    try {
      const parsed = new URL(panelUrl.startsWith("http") ? panelUrl : `https://${panelUrl}`);
      panelUrl = parsed.origin;
    } catch(e) {
      panelUrl = panelUrl.replace(/\/+$/, "");
    }
    const nodeKey = env.API_KEY || env.CLUSTER_KEY || env.NODE_KEY;
    if (!panelUrl || !nodeKey) return;

    let cfDaily = null;
    try {
      if (typeof getEdgeNodeCFUsage === "function") {
        cfDaily = await getEdgeNodeCFUsage(env);
      }
    } catch(e) {}

    const reqsToSend = pendingRequestsCount > 0 ? pendingRequestsCount : (totalPendingBytes > 0 ? 1 : 0);
    const finalRequests = (cfDaily !== null && cfDaily >= 0) ? cfDaily : reqsToSend;

    const trafficSnapshot = [];
    for (const [uuid, tr] of pendingUserTraffic.entries()) {
      if (tr.up > 0 || tr.down > 0) {
        trafficSnapshot.push({ uuid, up: Number(tr.up) || 0, down: Number(tr.down) || 0 });
      }
    }

    // اگر نه ترافیکی بود، نه استعلام کلادفلر و نه فورس، ریترن کن
    if (trafficSnapshot.length === 0 && finalRequests === 0 && !force) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${panelUrl.replace(/\/+$/, "")}/api/node/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Node-Key": nodeKey,
        "Authorization": `Bearer ${nodeKey}`
      },
      
      

      body: JSON.stringify({
        node_id: env.NODE_ID || (new URL(request?.url || "https://node.internal").hostname.split(".")[0]),
        timestamp: now,
        requests: finalRequests,
        requests_count: finalRequests,
        requests_delta: finalRequests,
        daily_requests: finalRequests,
        country: detectedCountry || "US",
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
        if (data && data.upstream_uri) {
          try {
            const rawUri = data.upstream_uri.trim();
            if (rawUri.startsWith("vless://")) {
              const uPart = rawUri.slice(8);
              const atIdx = uPart.indexOf("@");
              const qIdx = uPart.indexOf("?");
              const hPart = uPart.slice(atIdx + 1, qIdx !== -1 ? qIdx : undefined);
              const cIdx = hPart.lastIndexOf(":");
              activeUpstreamTarget = {
                host: cIdx !== -1 ? hPart.slice(0, cIdx) : hPart,
                port: cIdx !== -1 ? parseInt(hPart.slice(cIdx + 1)) : 443
              };
            }
          } catch(e) { activeUpstreamTarget = null; }
        } else if (data && !data.upstream_uri) {
          activeUpstreamTarget = null;
        }
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

async function establishSocketWithProxy(socketHolder, targetHost, targetPort, rawPayload, ws, responseHeader, userUuid, env, ctx, request) {
  let sock = null;
  const proxyIP = env?.PROXY_IP || DEFAULT_PROXY_IP;

  try {
    
    let isUpstreamReq = false;
    try {
      const reqUrl = new URL(request?.url || "https://node.internal");
      if (reqUrl.searchParams.get("upstream") === "true" || reqUrl.pathname.includes("upstream=true")) {
        isUpstreamReq = true;
      }
    } catch(e) {}
    const useUpstreamHere = isUpstreamReq || (activeUpstreamTarget !== null);

    const destHost = (useUpstreamHere && activeUpstreamTarget) ? activeUpstreamTarget.host : targetHost;
    const destPort = (useUpstreamHere && activeUpstreamTarget) ? activeUpstreamTarget.port : targetPort;
    sock = connect({ hostname: destHost, port: destPort });
    socketHolder.value = sock;

    if (rawPayload && rawPayload.byteLength > 0) {
      const writer = sock.writable.getWriter();
      await writer.write(rawPayload);
      writer.releaseLock();
    }
  } catch (directErr) {
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
    close() { 
      try { sock.close(); } catch {}
      if (ctx?.waitUntil) ctx.waitUntil(syncWithMaster(env, request, true));
    },
    abort() { 
      try { sock.close(); } catch {}
      if (ctx?.waitUntil) ctx.waitUntil(syncWithMaster(env, request, true));
    }
  });

  sock.readable.pipeTo(wsWriter).catch(() => {
    try { sock.close(); } catch {}
    safeCloseWebSocket(ws);
    if (ctx?.waitUntil) ctx.waitUntil(syncWithMaster(env, request, true));
  });
}

function handleVlessWS(request, env, ctx) {
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

      currentUserUuid = parsed.cleanUuid || parsed.rawUuid || parsed.uuid;
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
        env,
        ctx,
        request
      );
    },
    close() {
      if (socketHolder.value) try { socketHolder.value.close(); } catch {}
      if (ctx?.waitUntil) ctx.waitUntil(syncWithMaster(env, request, true));
    }
  });

  readableStream.pipeTo(writableStream).catch(() => {
    if (socketHolder.value) try { socketHolder.value.close(); } catch {}
    safeCloseWebSocket(serverWs);
    if (ctx?.waitUntil) ctx.waitUntil(syncWithMaster(env, request, true));
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
      return handleVlessWS(request, env, ctx);
    }

    if (path === "/vl" || path.startsWith("/vl/") || path === "/vless") {
      return new Response("VLESS WebSocket Endpoint - Awaiting Upgrade", {
        status: 426,
        headers: { "Upgrade": "websocket" }
      });
    }

    
    if (url.pathname === "/api/test-sync") {
      const panelUrl = (env.PANEL_URL || "").trim();
      const nodeKey = env.API_KEY || env.CLUSTER_KEY || env.NODE_KEY;
      let cfDaily = null;
      try {
        if (typeof getEdgeNodeCFUsage === "function") {
          cfDaily = await getEdgeNodeCFUsage(env);
        }
      } catch(e) {}

      const cleanUrl = panelUrl.replace(/\/+$/, "") + "/api/node/sync";
      try {
        const res = await fetch(cleanUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Node-Key": nodeKey || ""
          },
          body: JSON.stringify({
            node_id: env.NODE_ID || "nod-4",
            daily_requests: cfDaily || 0,
            country: "US"
          })
        });
        const resText = await res.text();
        return new Response(JSON.stringify({
          success: res.ok,
          status: res.status,
          target_url: cleanUrl,
          sent_node_key: nodeKey ? nodeKey.slice(0, 10) + "..." : null,
          cfDaily,
          response: resText
        }), { headers: { "Content-Type": "application/json" } });
      } catch(err) {
        return new Response(JSON.stringify({
          success: false,
          target_url: cleanUrl,
          error: err.message,
          stack: err.stack
        }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (path === "/api/status" || path === "/api/stats") {
      let cfDaily = 0;
      try {
        if (typeof getEdgeNodeCFUsage === "function") {
          const val = await getEdgeNodeCFUsage(env);
          if (val !== null && val >= 0) cfDaily = val;
        }
      } catch(e) {}
      return new Response(JSON.stringify({
        status: "active",
        role: "edge_node",
        node_id: env.NODE_ID || url.hostname.split(".")[0] || "edge-node",
        daily_requests: cfDaily,
        requests: cfDaily
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    
  // Debug Endpoint for GraphQL Verification
  
  // Trigger Manual Sync to Panel
  if (url.pathname === "/api/node/force-sync" || url.pathname === "/api/force-sync") {
    const nodeKey = env.API_KEY || env.CLUSTER_KEY || env.NODE_KEY;
    const reqKey = request.headers.get("X-Node-Key") || request.headers.get("Authorization")?.replace("Bearer ", "");
    if (nodeKey && reqKey !== nodeKey) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    try {
      if (typeof syncWithMaster === "function") {
        await syncWithMaster(env, request, true);
        return new Response(JSON.stringify({ success: true, message: "Sync dispatched to master panel" }), { headers: { "content-type": "application/json" } });
      }
    } catch(err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { "content-type": "application/json" } });
    }
  }

  if (url.pathname === "/api/debug-cf") {
    const nodeKey = env.API_KEY || env.CLUSTER_KEY || env.NODE_KEY;
    const reqKey = request.headers.get("X-Node-Key") || request.headers.get("Authorization")?.replace("Bearer ", "");
    if (nodeKey && reqKey !== nodeKey) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    const acc = env.CF_ACCOUNT_ID;
    const tok = env.CF_API_TOKEN;
    if (!acc || !tok) {
      return new Response(JSON.stringify({ error: "Missing CF_ACCOUNT_ID or CF_API_TOKEN in env", hasAcc: !!acc, hasTok: !!tok }), { headers: { "content-type": "application/json" } });
    }
    const val = await getEdgeNodeCFUsage(env);
    return new Response(JSON.stringify({ success: true, accountId: acc.slice(0, 6) + "...", requests: val }), { headers: { "content-type": "application/json" } });
  }

  return new Response("Service Available", { status: 200 });
  },

  // اجرای خودکار زمان‌بندی‌شده (Cron Trigger) جهت ارسال دوره‌ای آمار به مستر
  async scheduled(event, env, ctx) {
    if (typeof syncWithMaster === "function") {
      ctx.waitUntil(syncWithMaster(env, null, true));
    }
  }
};
