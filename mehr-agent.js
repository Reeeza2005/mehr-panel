import { connect } from "cloudflare:sockets";

const AGENT_VERSION = "1.6.3";
const DEFAULT_PROXY_IP = "bpb.yousefi.isegaro.com";

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
      signal: AbortSignal.timeout(4000)
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
function parseVlessHeader(buffer) {
  if (buffer.byteLength < 24) return { hasError: true, message: "Invalid VLESS header size" };
  const version = new Uint8Array(buffer.slice(0, 1));
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
    protocol: "vless"
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

async function pipeTcpToWebSocket(tcpSocket, ws, responseHeader) {
  let headerSent = !responseHeader;
  const writer = new WritableStream({
    async write(chunk) {
      if (ws.readyState !== 1) return;
      if (!headerSent) {
        ws.send(await new Blob([responseHeader, chunk]).arrayBuffer());
        headerSent = true;
      } else {
        ws.send(chunk);
      }
    },
    close() {
      safeCloseWebSocket(ws);
    },
    abort() {
      try { tcpSocket.close(); } catch (e) {}
    }
  });

  try {
    await tcpSocket.readable.pipeTo(writer);
  } catch (e) {
    try { tcpSocket.close(); } catch (err) {}
    safeCloseWebSocket(ws);
  }
}

async function handleProxyWebSocket(request) {
  const wsPair = new WebSocketPair();
  const [clientWs, serverWs] = Object.values(wsPair);
  serverWs.accept();
  serverWs.binaryType = "arraybuffer";

  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
  const readableStream = makeWebSocketReadableStream(serverWs, earlyDataHeader);

  let tcpHolder = { value: null };

  const writableStream = new WritableStream({
    async write(chunk) {
      if (tcpHolder.value) {
        const tcpWriter = tcpHolder.value.writable.getWriter();
        await tcpWriter.write(chunk);
        tcpWriter.releaseLock();
        return;
      }

      const parsed = parseProxyHeader(chunk);
      if (parsed.hasError) {
        throw new Error(parsed.message);
      }

      const clientData = chunk.byteLength >= parsed.rawDataIndex ? chunk.slice(parsed.rawDataIndex) : new ArrayBuffer(0);
      const respHeader = parsed.protocol === "vless" ? new Uint8Array([parsed.version[0], 0]) : null;

      let sock;
      try {
        sock = connect({ hostname: parsed.address, port: parsed.port });
        tcpHolder.value = sock;
        const sockWriter = sock.writable.getWriter();
        if (clientData.byteLength > 0) {
          await sockWriter.write(clientData);
        }
        sockWriter.releaseLock();
      } catch (err) {
        sock = connect({ hostname: DEFAULT_PROXY_IP, port: parsed.port === 443 ? 443 : 80 });
        tcpHolder.value = sock;
        const sockWriter = sock.writable.getWriter();
        if (clientData.byteLength > 0) {
          await sockWriter.write(clientData);
        }
        sockWriter.releaseLock();
      }

      pipeTcpToWebSocket(sock, serverWs, respHeader);
    },
    close() {
      if (tcpHolder.value) try { tcpHolder.value.close(); } catch(e) {}
    },
    abort() {
      if (tcpHolder.value) try { tcpHolder.value.close(); } catch(e) {}
    }
  });

  readableStream.pipeTo(writableStream).catch(() => {
    if (tcpHolder.value) try { tcpHolder.value.close(); } catch(e) {}
  });

  return new Response(null, { status: 101, webSocket: clientWs });
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const upgrade = request.headers.get("Upgrade") || "";

      if (upgrade.toLowerCase() === "websocket") {
        return handleProxyWebSocket(request);
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
