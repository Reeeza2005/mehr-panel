import { connect } from "cloudflare:sockets";

const AGENT_VERSION = "1.5.6";
const DEFAULT_PROXY_IP = "bpb.yousefi.isegaro.com";

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
    isUDP
  };
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

async function handleVlessWebSocket(request) {
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

      const parsed = parseVlessHeader(chunk);
      if (parsed.hasError) {
        throw new Error(parsed.message);
      }

      const clientData = chunk.slice(parsed.rawDataIndex);
      const respHeader = new Uint8Array([parsed.version[0], 0]);

      // اتصال سوکت بالادست
      let sock;
      try {
        sock = connect({ hostname: parsed.address, port: parsed.port });
        tcpHolder.value = sock;
        const sockWriter = sock.writable.getWriter();
        await sockWriter.write(clientData);
        sockWriter.releaseLock();
      } catch (err) {
        // فال‌بک به Proxy IP در صورت مسدود بودن اتصال مستقیم
        sock = connect({ hostname: DEFAULT_PROXY_IP, port: parsed.port === 443 ? 443 : 80 });
        tcpHolder.value = sock;
        const sockWriter = sock.writable.getWriter();
        await sockWriter.write(clientData);
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

      // ۱. هندل اتصال وب‌سوکت پروکسی
      if (upgrade.toLowerCase() === "websocket") {
        return handleVlessWebSocket(request);
      }

      // ۲. اندپوینت احراز هویت و بررسی سلامت پنل
      if (url.pathname === "/api/status") {
        const auth = request.headers.get("Authorization");
        const key = env.API_KEY || env.CLUSTER_KEY || env.NODE_KEY || "";
        if (key && auth !== "Bearer " + key) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({
          status: "online",
          node_id: env.NODE_ID || "node-edge-3",
          version: AGENT_VERSION
        }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      // ۳. پاسخ لندینگ پیش‌فرض
      return new Response(JSON.stringify({
        status: "active",
        service: "Mehr Edge Node",
        node_id: env.NODE_ID || "node-edge-3",
        version: AGENT_VERSION
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
