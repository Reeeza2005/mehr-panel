function parseChainTarget(uri) {
  if (!uri || typeof uri !== "string") return null;
  try {
    let cleanUri = uri.trim();
    if (cleanUri.startsWith("vmess://")) {
      const raw = atob(cleanUri.replace("vmess://", ""));
      const j = JSON.parse(raw);
      return { host: j.add || j.host, port: parseInt(j.port) || 443 };
    }
    if (cleanUri.includes("://")) {
      const u = new URL(cleanUri);
      return { host: u.hostname, port: parseInt(u.port) || 443 };
    }
    const parts = cleanUri.split(":");
    return { host: parts[0], port: parseInt(parts[1]) || 443 };
  } catch(e) {
    return null;
  }
}


async function forceSyncUsers(env) {
  try {
    const targetUrl = (env.PANEL_URL || "https://mehr.299u2reg6.workers.dev").replace(/\/+$/, "") + "/api/node/sync";
    const key = env.CLUSTER_KEY || "mehr_cluster_secret_2026";
    const headers = {
      "Content-Type": "application/json",
      "X-Node-Key": key,
      "Authorization": "Bearer " + key
    };
    const body = JSON.stringify({
      node_id: env.NODE_ID || "node-2",
      timestamp: Date.now(),
      requests: 0
    });

    let res = null;
    if (env.PANEL_SERVICE && typeof env.PANEL_SERVICE.fetch === "function") {
      res = await env.PANEL_SERVICE.fetch(targetUrl, { method: "POST", headers, body });
    }
    if (!res || !res.ok) {
      res = await fetch(targetUrl, { method: "POST", headers, body });
    }
    if (res && res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.allowed_uuids)) {
        cachedAllowedUsers = new Set(data.allowed_uuids.map(x => String(x).toLowerCase()));
        updateTrojanCache(data.allowed_uuids);
        return true;
      }
    }
  } catch (err) {}
  return false;
}

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

async function dispatchToMaster(env, targetUrl, init) {
  if (env.PANEL_SERVICE && typeof env.PANEL_SERVICE.fetch === "function") {
    return await env.PANEL_SERVICE.fetch(targetUrl, init);
  }
  return await fetch(targetUrl, init);
}


const DEFAULT_PROXY_IP = "134.209.136.197";

var cachedAllowedUsers = new Set();
var cachedBlockedUsers = new Set();
var trojanHashToUuid = new Map();
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
    const needInitialSync = (cachedAllowedUsers.size === 0 || trojanHashToUuid.size === 0);
    if (trafficSnapshot.length === 0 && finalRequests === 0 && !force && !needInitialSync) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const targetSyncUrl = `${panelUrl.replace(/\/+$/, "")}/api/node/sync`;
    const syncHeaders = {
      "Content-Type": "application/json",
      "X-Node-Key": nodeKey,
      "Authorization": `Bearer ${nodeKey}`
    };
    const syncBody = JSON.stringify({
      node_id: env.NODE_ID || (new URL(request?.url || "https://node.internal").hostname.split(".")[0]),
      timestamp: now,
      requests: finalRequests,
      requests_count: finalRequests,
      requests_delta: finalRequests,
      daily_requests: finalRequests,
      country: detectedCountry || "US",
      user_traffic: trafficSnapshot
    });

    let res = null;
    try {
      if (env.PANEL_SERVICE && typeof env.PANEL_SERVICE.fetch === "function") {
        res = await env.PANEL_SERVICE.fetch(targetSyncUrl, {
          method: "POST",
          headers: syncHeaders,
          body: syncBody
        });
      } else {
        res = await fetch(targetSyncUrl, {
          method: "POST",
          headers: syncHeaders,
          body: syncBody
        });
      }
    } catch (err) {
      console.error("SYNC_DISPATCH_ERROR:", err?.message || err);
      try {
        res = await fetch(targetSyncUrl, {
          method: "POST",
          headers: syncHeaders,
          body: syncBody
        });
      } catch (e2) {
        res = null;
      }
    }

    clearTimeout(timer);

    if (res && res.ok) {
      console.log(`[SYNC] Master response OK (${res.status})`);
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
            activeUpstreamTarget = parseChainTarget(rawUri);
          } catch(e) { activeUpstreamTarget = null; }
        } else if (data && !data.upstream_uri) {
          activeUpstreamTarget = null;
        }
      console.log(`[SYNC] Payload received: allowed=${data?.allowed_uuids?.length || 0}`);
      if (data) {
        if (Array.isArray(data.allowed_uuids)) {
          cachedAllowedUsers = new Set(data.allowed_uuids.map(x => String(x).toLowerCase()));
          updateTrojanCache(data.allowed_uuids);
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


function sha224Hex(m) {
  const msg = new TextEncoder().encode(m);
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  let H = [
    0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511,
    0x64f98fa7, 0xbefa4fa4
  ];
  const words = [];
  const n = Math.ceil((msg.length + 9) / 64) * 16;
  for (let i = 0; i < n; i++) words[i] = 0;
  for (let i = 0; i < msg.length; i++) words[i >> 2] |= msg[i] << (24 - (i % 4) * 8);
  words[msg.length >> 2] |= 0x80 << (24 - (msg.length % 4) * 8);
  words[n - 1] = msg.length * 8;
  const W = [];
  for (let i = 0; i < n; i += 16) {
    let [a, b, c, d, e, f, g, h] = H;
    for (let j = 0; j < 64; j++) {
      if (j < 16) W[j] = words[i + j];
      else {
        let w15 = W[j - 15], w2 = W[j - 2];
        let s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
        let s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
        W[j] = (W[j - 16] + s0 + W[j - 7] + s1) >>> 0;
      }
      let S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      let ch = (e & f) ^ (~e & g);
      let temp1 = (h + S1 + ch + K[j] + W[j]) >>> 0;
      let S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      let maj = (a & b) ^ (a & c) ^ (b & c);
      let temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return H.slice(0, 7).map(v => v.toString(16).padStart(8, "0")).join("");
}

function updateTrojanCache(allowedUuids) {
  trojanHashToUuid.clear();
  if (!Array.isArray(allowedUuids)) return;
  for (const u of allowedUuids) {
    const raw = String(u).trim().toLowerCase();
    if (!raw) continue;
    // ۱. هش با خط تیره
    trojanHashToUuid.set(sha224Hex(raw), raw);
    // ۲. هش بدون خط تیره
    const noDash = raw.replace(/-/g, "");
    if (noDash !== raw) {
      trojanHashToUuid.set(sha224Hex(noDash), raw);
    }
  }
}

function parseTrojanHeader(buffer) {
  let ab = buffer;
  if (buffer instanceof Uint8Array || ArrayBuffer.isView(buffer)) {
    ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  if (ab.byteLength < 58) return { hasError: true, message: "trojan data too short" };

  const view = new Uint8Array(ab);
  let ePos = -1;
  for (let i = 0; i < Math.min(ab.byteLength - 1, 128); i++) {
    if (view[i] === 0x0d && view[i + 1] === 0x0a) {
      ePos = i;
      break;
    }
  }
  if (ePos === -1) return { hasError: true, message: "crlf not found in trojan header" };

  const clientHashHex = new TextDecoder().decode(view.slice(0, ePos)).toLowerCase().trim();
  let matchedUuid = trojanHashToUuid.get(clientHashHex);

  if (!matchedUuid) {
    if (cachedAllowedUsers.size > 0) {
      updateTrojanCache(Array.from(cachedAllowedUsers));
      matchedUuid = trojanHashToUuid.get(clientHashHex);
    }
  }
  if (!matchedUuid) {
    return { hasError: true, message: `trojan unauthorized (hash:${clientHashHex.slice(0, 8)}... cache_sz:${trojanHashToUuid.size})` };
  }
  if (cachedBlockedUsers.size > 0 && cachedBlockedUsers.has(matchedUuid)) {
    return { hasError: true, message: "user blocked" };
  }

  let hPos = ePos + 2;
  const cmd = view[hPos];
  hPos++;
  const aType = view[hPos];
  hPos++;
  let aLen = 0;
  let targetAddr = "";

  if (aType === 1) {
    aLen = 4;
    targetAddr = view.slice(hPos, hPos + aLen).join(".");
  } else if (aType === 3) {
    aLen = view[hPos];
    hPos++;
    targetAddr = new TextDecoder().decode(view.slice(hPos, hPos + aLen));
  } else if (aType === 4) {
    aLen = 16;
    const dv = new DataView(ab.slice(hPos, hPos + aLen));
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(dv.getUint16(i * 2).toString(16));
    targetAddr = parts.join(":");
  } else {
    return { hasError: true, message: "invalid trojan address type" };
  }

  hPos += aLen;
  const targetPort = new DataView(ab.slice(hPos, hPos + 2)).getUint16(0);
  hPos += 2;
  // رد کردن ۲ بایت CRLF (0x0d, 0x0a) انتهای هدر پروتکل تروجان
  if (hPos + 1 < ab.byteLength && view[hPos] === 0x0d && view[hPos + 1] === 0x0a) {
    hPos += 2;
  }
  const rawOffset = hPos;

  return {
    hasError: false,
    uuid: matchedUuid,
    addressRemote: targetAddr,
    portRemote: targetPort,
    rawDataIndex: rawOffset,
    isUDP: cmd === 3,
    isTrojan: true,
    rawBuffer: ab
  };
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
    
    let chainTarget = null;
    try {
      const reqUrl = new URL(request?.url || "https://node.internal");
      const chainParam = reqUrl.searchParams.get("chain");
      if (chainParam) {
        chainTarget = parseChainTarget(decodeURIComponent(chainParam));
      } else if (reqUrl.searchParams.get("upstream") === "true" || reqUrl.pathname.includes("upstream=true")) {
        chainTarget = activeUpstreamTarget;
      }
    } catch(e) {}

    const selectedTarget = chainTarget || activeUpstreamTarget;
    const destHost = selectedTarget ? selectedTarget.host : targetHost;
    const destPort = selectedTarget ? selectedTarget.port : targetPort;
    sock = connect({ hostname: destHost, port: destPort });
    socketHolder.value = sock;

    if (rawPayload && rawPayload.byteLength > 0) {
      const writer = sock.writable.getWriter();
      await writer.write(rawPayload);
      writer.releaseLock();
    }
  } catch (directErr) {
    console.error("DIRECT_CONNECT_ERROR:", directErr?.message || directErr);
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
      try { ws.close(1011, "ERR_CONNECT:" + (proxyErr?.message || "failed")); } catch {}
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

      const firstByte = new Uint8Array(chunk)[0];
      const isVless = (firstByte === 0x00);
      let parsed = isVless ? parseVlessHeader(chunk) : parseTrojanHeader(chunk);
      if (parsed.hasError && !isVless && trojanHashToUuid.size === 0) {
        try { await syncWithMaster(env, request, true); } catch(e) {}
        parsed = parseTrojanHeader(chunk);
      }
      if (parsed.hasError) {
        try { serverWs.close(1008, "ERR_PARSE:" + parsed.message); } catch {}
        return;
      }

      currentUserUuid = parsed.cleanUuid || parsed.rawUuid || parsed.uuid;
      const vlessResponseHeader = isVless ? new Uint8Array([parsed.VLVersion[0], 0]) : null;
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
    const testUrl = new URL(request.url);
    if (testUrl.pathname === "/ping") {
      return new Response(JSON.stringify({ status: "alive", node: env.NODE_ID || "unknown" }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    const url = new URL(request.url);
    const path = url.pathname.toLowerCase();
    const upgradeHeader = request.headers.get("Upgrade") || request.headers.get("upgrade") || "";
    const isWebSocket = upgradeHeader.toLowerCase() === "websocket";

    if (isWebSocket) {
      pendingRequestsCount++;
      if (trojanHashToUuid.size === 0 || cachedAllowedUsers.size === 0) {
        await forceSyncUsers(env);
      }
      if (trojanHashToUuid.size === 0 || cachedAllowedUsers.size === 0) {
        try { await syncWithMaster(env, request, true); } catch(e) {}
      }
      return handleVlessWS(request, env, ctx);
    }

    if (path === "/vl" || path.startsWith("/vl/") || path === "/vless") {
      return new Response("VLESS WebSocket Endpoint - Awaiting Upgrade", {
        status: 426,
        headers: { "Upgrade": "websocket" }
      });
    }

    
    if (url.pathname === "/api/test-sync") {
      const panelUrl = (env.PANEL_URL || "").trim().replace(/\/+$/, "");
      const nodeKey = env.API_KEY || env.CLUSTER_KEY || env.NODE_KEY || "";
      const cleanUrl = panelUrl + "/api/node/sync";

      try {
        const res = await dispatchToMaster(env, cleanUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Node-Key": nodeKey
          },
          body: JSON.stringify({
            node_id: env.NODE_ID || "node-2",
            daily_requests: 0,
            country: "US"
          })
        });
        const resText = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(resText); } catch(e) {}

        if (parsed && Array.isArray(parsed.allowed_uuids)) {
          cachedAllowedUsers = new Set(parsed.allowed_uuids.map(x => String(x).toLowerCase()));
          if (typeof updateTrojanCache === "function") {
            updateTrojanCache(parsed.allowed_uuids);
          }
        }

        return new Response(JSON.stringify({
          success: res.ok,
          status: res.status,
          target_url: cleanUrl,
          allowed_count: cachedAllowedUsers ? cachedAllowedUsers.size : 0,
          trojan_cache_size: typeof trojanHashToUuid !== "undefined" ? trojanHashToUuid.size : 0,
          response_sample: resText.slice(0, 200)
        }, null, 2), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({
          success: false,
          target_url: cleanUrl,
          error: err.message,
          stack: err.stack
        }, null, 2), { status: 500, headers: { "Content-Type": "application/json" } });
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
