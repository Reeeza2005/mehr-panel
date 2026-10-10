import { connect } from "cloudflare:sockets";

const AGENT_VERSION = "1.7.0";
const DEFAULT_PROXY_IP = "bpb.yousefi.isegaro.com";

// وضعیت سراسری نود در حافظه
let blockedUuids = new Set();
let upstreamConfig = { enabled: false, uri: "" };
const activeUserSessions = new Map(); // uuid -> connection count
const MAX_CONCURRENT_USERS = 5;

function parseChainTarget(uri) {
  if (!uri || typeof uri !== "string") return null;
  try {
    let cleanUri = uri.trim();
    if (cleanUri.startsWith("vmess://")) {
      const raw = atob(cleanUri.replace("vmess://", ""));
      const j = JSON.parse(raw);
      return { host: j.add || j.host, port: parseInt(j.port) || 443 };
    }
    const u = new URL(cleanUri);
    return { host: u.hostname, port: parseInt(u.port) || 443 };
  } catch(e) {
    return null;
  }
}

async function reportTrafficToMaster(env, userUuid, upBytes, downBytes) {
  const masterUrl = env.MASTER_URL || env.PANEL_URL;
  const apiKey = env.API_KEY;
  const nodeId = env.NODE_ID || "node-edge-3";

  if (!masterUrl) return;

  try {
    const cleanUrl = masterUrl.replace(/\/+$/, "");
    const serviceBinding = env.MASTER_SERVICE || env.PANEL_SERVICE;
    const fetchHandler = (serviceBinding && typeof serviceBinding.fetch === "function") 
      ? serviceBinding 
      : { fetch: fetch };

    const bodyPayload = {
      node_id: nodeId,
      requests_delta: 1,
      user_traffic: []
    };

    if (userUuid && (upBytes > 0 || downBytes > 0)) {
      bodyPayload.user_traffic.push({
        uuid: userUuid,
        up: upBytes,
        down: downBytes
      });
    }

    const resp = await fetchHandler.fetch(`${cleanUrl}/api/node/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Node-Key": apiKey || ""
      },
      body: JSON.stringify(bodyPayload),
      signal: AbortSignal.timeout(6000)
    });

    if (resp.ok) {
      try {
        const syncData = await resp.json();
        if (syncData && syncData.success) {
          if (Array.isArray(syncData.blocked_uuids)) {
            blockedUuids = new Set(syncData.blocked_uuids);
          }
          if (syncData.upstream_uri !== undefined) {
            upstreamConfig.uri = syncData.upstream_uri;
            upstreamConfig.enabled = Boolean(syncData.use_upstream);
          }
        }
      } catch(_) {}
    }
  } catch (err) {
    console.log(`[SYNC-ERROR] ${err.name}: ${err.message}`);
  }
}

let cachedDailyRequests = null;
let lastAnalyticsFetchTime = 0;

async function getAccountDailyRequests(env) {
  const accountId = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!accountId || !token) return 0;

  const now = Date.now();
  // کش ۵ دقیقه‌ای برای صرفه‌جویی در درخواست‌های API
  if (cachedDailyRequests !== null && (now - lastAnalyticsFetchTime) < 300000) {
    return cachedDailyRequests;
  }

  try {
    const since = new Date(now - 86400000).toISOString();
    const query = `query {
      viewer {
        accounts(filter: {accountTag: "${accountId}"}) {
          workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: "${since}"}) {
            sum { requests }
          }
          pagesFunctionsInvocationsAdaptiveGroups(limit: 1, filter: {datetime_geq: "${since}"}) {
            sum { requests }
          }
        }
      }
    }`;

    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(6000)
    });

    if (res.ok) {
      const data = await res.json();
      const acc = data?.data?.viewer?.accounts?.[0];
      const workersReq = Number(acc?.workersInvocationsAdaptive?.[0]?.sum?.requests || 0);
      const pagesReq = Number(acc?.pagesFunctionsInvocationsAdaptiveGroups?.[0]?.sum?.requests || 0);
      cachedDailyRequests = workersReq + pagesReq;
      lastAnalyticsFetchTime = now;
      return cachedDailyRequests;
    }
  } catch (e) {}

  return cachedDailyRequests !== null ? cachedDailyRequests : 0;
}


function safeCloseWebSocket(ws) {
  try {
    if (ws.readyState === 1 || ws.readyState === 2) ws.close();
  } catch (e) {}
}

function decodeBase64EarlyData(header) {
  if (!header) return null;
  try {
    const b64 = header.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    return Uint8Array.from(bin, c => c.charCodeAt(0)).buffer;
  } catch (e) {
    return null;
  }
}

function makeWebSocketReadableStream(ws, earlyDataHeader) {
  let isClosed = false;
  return new ReadableStream({
    start(controller) {
      ws.addEventListener("message", e => {
        if (!isClosed) controller.enqueue(e.data);
      });
      ws.addEventListener("close", () => {
        safeCloseWebSocket(ws);
        if (!isClosed) controller.close();
      });
      ws.addEventListener("error", err => {
        if (!isClosed) controller.error(err);
      });
      const earlyData = decodeBase64EarlyData(earlyDataHeader);
      if (earlyData) controller.enqueue(earlyData);
    },
    cancel() {
      isClosed = true;
      safeCloseWebSocket(ws);
    }
  });
}

// -------------------------------------------------------------
// پارس هدر VLESS
// -------------------------------------------------------------
function stringifyUuid(buf) {
  const bytes = new Uint8Array(buf);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function parseVlessHeader(buffer) {
  if (buffer.byteLength < 24) return { hasError: true, message: "Invalid VLESS header size" };
  const version = new Uint8Array(buffer.slice(0, 1));
  const userUuid = stringifyUuid(buffer.slice(1, 17));
  const optLength = new Uint8Array(buffer.slice(17, 18))[0];
  const cmd = new Uint8Array(buffer.slice(18 + optLength, 18 + optLength + 1))[0];
  const isUDP = cmd === 2;

  if (cmd !== 1 && cmd !== 2) {
    return { hasError: true, message: "Unsupported VLESS command: " + cmd };
  }

  const portIdx = 18 + optLength + 1;
  const port = new DataView(buffer.slice(portIdx, portIdx + 2)).getUint16(0);

  let addrIdx = portIdx + 2;
  const addrType = new Uint8Array(buffer.slice(addrIdx, addrIdx + 1))[0];
  addrIdx += 1;

  let address = "";
  let rawDataIdx = 0;

  if (addrType === 1) {
    address = new Uint8Array(buffer.slice(addrIdx, addrIdx + 4)).join(".");
    rawDataIdx = addrIdx + 4;
  } else if (addrType === 2) {
    const domainLen = new Uint8Array(buffer.slice(addrIdx, addrIdx + 1))[0];
    addrIdx += 1;
    address = new TextDecoder().decode(buffer.slice(addrIdx, addrIdx + domainLen));
    rawDataIdx = addrIdx + domainLen;
  } else if (addrType === 3) {
    const dv = new DataView(buffer.slice(addrIdx, addrIdx + 16));
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(dv.getUint16(i * 2).toString(16));
    address = parts.join(":");
    rawDataIdx = addrIdx + 16;
  } else {
    return { hasError: true, message: "Invalid address type: " + addrType };
  }

  return {
    hasError: false,
    address,
    port,
    rawDataIndex: rawDataIdx,
    version,
    isUDP,
    protocol: "vless",
    userUuid
  };
}

// -------------------------------------------------------------
// پارس هدر Trojan (منطبق بر سورس مرجع BPB Io)
// -------------------------------------------------------------
function parseTrojanHeader(buffer) {
  if (buffer.byteLength < 56) return { hasError: true, message: "Invalid Trojan buffer length" };

  const cr = new Uint8Array(buffer.slice(56, 57))[0];
  const lf = new Uint8Array(buffer.slice(57, 58))[0];
  if (cr !== 13 || lf !== 10) {
    return { hasError: true, message: "Invalid Trojan CRLF delimiter" };
  }

  const socks5 = buffer.slice(58);
  if (socks5.byteLength < 6) return { hasError: true, message: "Invalid SOCKS5 frame" };

  const view = new DataView(socks5);
  const cmd = view.getUint8(0);
  if (cmd !== 1) return { hasError: true, message: "Unsupported Trojan command: " + cmd };

  const addrType = view.getUint8(1);
  let addrLen = 0;
  let offset = 2;
  let address = "";

  if (addrType === 1) {
    addrLen = 4;
    address = new Uint8Array(socks5.slice(offset, offset + addrLen)).join(".");
  } else if (addrType === 3) {
    addrLen = new Uint8Array(socks5.slice(offset, offset + 1))[0];
    offset += 1;
    address = new TextDecoder().decode(socks5.slice(offset, offset + addrLen));
  } else if (addrType === 4) {
    addrLen = 16;
    const dv = new DataView(socks5.slice(offset, offset + addrLen));
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(dv.getUint16(i * 2).toString(16));
    address = parts.join(":");
  } else {
    return { hasError: true, message: "Invalid Trojan addressType: " + addrType };
  }

  const portOffset = offset + addrLen;
  const port = new DataView(socks5.slice(portOffset, portOffset + 2)).getUint16(0);

  // در تروجان بعد از پورت ۲ بایت CRLF قرار دارد: offset + 2 (port) + 2 (CRLF) = portOffset + 4
  const rawDataIdx = 58 + portOffset + 4;

  return {
    hasError: false,
    address,
    port,
    rawDataIndex: rawDataIdx,
    version: null,
    isUDP: false,
    protocol: "trojan"
  };
}

// تشخیص خودکار پروتکل بر مبنای هدر بسته
function parseProxyHeader(buffer) {
  if (buffer.byteLength >= 58) {
    const cr = new Uint8Array(buffer.slice(56, 57))[0];
    const lf = new Uint8Array(buffer.slice(57, 58))[0];
    if (cr === 13 && lf === 10) {
      return parseTrojanHeader(buffer);
    }
  }
  return parseVlessHeader(buffer);
}

async function pipeTcpToWebSocket(tcpSocket, ws, responseHeader, onDownBytes, onDone) {
  let headerSent = !responseHeader;
  const writer = new WritableStream({
    async write(chunk) {
      if (ws.readyState !== 1) return;
      const bLen = chunk.byteLength || 0;
      if (typeof onDownBytes === "function" && bLen > 0) onDownBytes(bLen);
      if (!headerSent) {
        const merged = new Uint8Array(responseHeader.byteLength + bLen);
        merged.set(new Uint8Array(responseHeader), 0);
        merged.set(new Uint8Array(chunk), responseHeader.byteLength);
        ws.send(merged.buffer);
        headerSent = true;
      } else {
        ws.send(chunk);
      }
    }
    close() {
      if (typeof onDone === "function") onDone();
      safeCloseWebSocket(ws);
    },
    abort() {
      if (typeof onDone === "function") onDone();
      try { tcpSocket.close(); } catch (e) {}
    }
  });

  try {
    await tcpSocket.readable.pipeTo(writer);
  } catch (e) {
    if (typeof onDone === "function") onDone();
    try { tcpSocket.close(); } catch (err) {}
    safeCloseWebSocket(ws);
  }
}

async function handleProxyWebSocket(request, env, ctx) {
  const wsPair = new WebSocketPair();
  const [clientWs, serverWs] = Object.values(wsPair);
  serverWs.accept();
  serverWs.binaryType = "arraybuffer";

  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
  const readableStream = makeWebSocketReadableStream(serverWs, earlyDataHeader);

  let tcpHolder = { value: null };
  let activeTcpWriter = null;
  let trackedUuid = null;
  let isSessionCounted = false;
  let totalUpBytes = 0;
  let totalDownBytes = 0;

  let lastSyncTime = Date.now();
  let isSyncing = false;
  const SYNC_INTERVAL_MS = 60000;

  const flushTraffic = (force = false) => {
    const now = Date.now();
    if (!trackedUuid || !env || isSyncing) return;
    if (totalUpBytes + totalDownBytes < 4096 && !force) return;
    if (!force && (now - lastSyncTime < SYNC_INTERVAL_MS)) return;

    const up = totalUpBytes;
    const down = totalDownBytes;
    totalUpBytes = 0;
    totalDownBytes = 0;
    lastSyncTime = now;
    isSyncing = true;

    const syncPromise = reportTrafficToMaster(env, trackedUuid, up, down)
      .finally(() => {
        isSyncing = false;
      });

    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(syncPromise);
    }
  };

  const cleanupSession = () => {
    if (activeTcpWriter) {
      try { activeTcpWriter.releaseLock(); } catch(e){}
      activeTcpWriter = null;
    }
    if (isSessionCounted && trackedUuid) {
      const cur = activeUserSessions.get(trackedUuid) || 1;
      if (cur <= 1) {
        activeUserSessions.delete(trackedUuid);
      } else {
        activeUserSessions.set(trackedUuid, cur - 1);
      }
      isSessionCounted = false;
    }
    flushTraffic(true);
    if (tcpHolder.value) {
      try { tcpHolder.value.close(); } catch(e){}
      tcpHolder.value = null;
    }
    safeCloseWebSocket(serverWs);
  };

  const checkLiveFlush = () => {
    if (!isSyncing && (Date.now() - lastSyncTime >= SYNC_INTERVAL_MS)) {
      flushTraffic(false);
    }
  };

  const writableStream = new WritableStream({
    async write(chunk) {
      if (activeTcpWriter) {
        totalUpBytes += (chunk.byteLength || 0);
        await activeTcpWriter.write(chunk);
        return;
      }

      const parsed = parseProxyHeader(chunk);
      if (parsed.hasError) {
        throw new Error(parsed.message);
      }

      trackedUuid = parsed.userUuid || null;

      // ۱. اعتبارسنجی وضعیت مسدودی کاربر
      if (trackedUuid && blockedUuids.has(trackedUuid)) {
        throw new Error("User blocked or quota exceeded");
      }

      // ۲. کنترل محدودیت ۵ کاربر همزمان در هر نود
      if (trackedUuid) {
        const isExistingUser = activeUserSessions.has(trackedUuid);
        if (!isExistingUser && activeUserSessions.size >= MAX_CONCURRENT_USERS) {
          throw new Error("Node capacity reached (max 5 concurrent users)");
        }
        activeUserSessions.set(trackedUuid, (activeUserSessions.get(trackedUuid) || 0) + 1);
        isSessionCounted = true;
      }

      const clientData = chunk.byteLength >= parsed.rawDataIndex ? chunk.slice(parsed.rawDataIndex) : new ArrayBuffer(0);
      if (clientData.byteLength > 0) totalUpBytes += clientData.byteLength;
      const respHeader = parsed.protocol === "vless" ? new Uint8Array([parsed.version[0], 0]) : null;

      let sock;
      // ۳. مدیریت اتصال به مقصد یا آپ‌استریم (Proxy Chain)
      const chainTarget = (upstreamConfig.enabled && upstreamConfig.uri) ? parseChainTarget(upstreamConfig.uri) : null;
      const destHost = chainTarget ? chainTarget.host : parsed.address;
      const destPort = chainTarget ? chainTarget.port : parsed.port;

      try {
        sock = connect({ hostname: destHost, port: destPort });
        tcpHolder.value = sock;
        activeTcpWriter = sock.writable.getWriter();
        if (clientData.byteLength > 0) {
          await activeTcpWriter.write(clientData);
        }
      } catch (err) {
        sock = connect({ hostname: DEFAULT_PROXY_IP, port: parsed.port === 443 ? 443 : 80 });
        tcpHolder.value = sock;
        activeTcpWriter = sock.writable.getWriter();
        if (clientData.byteLength > 0) {
          await activeTcpWriter.write(clientData);
        }
      }

      const tcpToWsPromise = pipeTcpToWebSocket(sock, serverWs, respHeader, (downLen) => {
        totalDownBytes += downLen;
        checkLiveFlush();
      }, () => cleanupSession());

      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(tcpToWsPromise);
      }
    },
    close() {
      cleanupSession();
    },
    abort() {
      cleanupSession();
    }
  });

  readableStream.pipeTo(writableStream).catch(() => {
    cleanupSession();
  });

  return new Response(null, { status: 101, webSocket: clientWs });
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const upgrade = request.headers.get("Upgrade") || "";

      if (upgrade.toLowerCase() === "websocket") {
        return handleProxyWebSocket(request, env, ctx);
      }

      if (url.pathname === "/api/status") {
        const dailyRequests = await getAccountDailyRequests(env);
        return new Response(JSON.stringify({
          status: "online",
          node_id: env.NODE_ID || "node-edge-3",
          version: AGENT_VERSION,
          protocols: ["vless", "trojan"],
          daily_requests: dailyRequests
        }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({
        status: "active",
        service: "Mehr Edge Node",
        node_id: env.NODE_ID || "node-edge-3",
        version: AGENT_VERSION,
        protocols: ["vless", "trojan"]
      }, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};
