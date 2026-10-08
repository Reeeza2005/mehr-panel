// =============================================================================
// Mehr Lightweight Edge Agent (BPB-Pattern Architecture)
// =============================================================================
import { connect } from 'cloudflare:sockets';

// پیکربندی و وضعیت پیش‌فرض درون‌حافظه‌ای نود
let dynamicConfig = {
    proxyIP: "",            // جایگاه آماده برای پروکسی‌آی‌پی
    chainingEnabled: false, // جایگاه آماده برای پروکسی‌چین
    upstreamHost: "",
    upstreamPort: 0,
    blockedDomains: []      // جایگاه آماده برای روتر هوشمند
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // ۱. اندپوینت‌های مدیریتی پنل مستر (محافظت شده با API_KEY)
        if (url.pathname.startsWith("/api/")) {
            return await handleManagementApi(request, env);
        }

        // ۲. پردازش اتصالات ترافیکی پروتکل‌ها (WebSocket)
        const upgradeHeader = request.headers.get("Upgrade");
        if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
            return await handleTrafficStream(request, env);
        }

        // ۳. صفحه لندینگ ساده نود
        return new Response(JSON.stringify({
            status: "active",
            node_id: env.NODE_ID || "unknown",
            engine: "mehr-agent-bpb",
            version: "1.0.0"
        }, null, 2), {
            headers: { "Content-Type": "application/json; charset=utf-8" }
        });
    }
};

// -----------------------------------------------------------------------------
// مدیریت API پنل مستر (احراز هویت و پاسخ‌دهی)
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

    // استعلام وضعیت نود
    if (url.pathname === "/api/status" && request.method === "GET") {
        return new Response(JSON.stringify({
            success: true,
            node_id: env.NODE_ID,
            status: "online",
            config: dynamicConfig,
            timestamp: Date.now()
        }), { headers: { "Content-Type": "application/json" } });
    }

    // استعلام آمار مصرف اکانت از کلادفلر
    if (url.pathname === "/api/stats" && request.method === "GET") {
        const stats = await fetchCloudflareStats(env);
        return new Response(JSON.stringify({
            success: true,
            stats
        }), { headers: { "Content-Type": "application/json" } });
    }

    // دریافت و اعمال تغییرات کانفیگ (آماده برای آپدیت‌های بعدی)
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
// دریافت آمار از GraphQL کلادفلر
// -----------------------------------------------------------------------------
async function fetchCloudflareStats(env) {
    const accountId = env.CF_ACCOUNT_ID;
    const apiToken = env.CF_API_TOKEN;

    if (!accountId || !apiToken) {
        return { requests_today: 0, status: "credentials_not_provided" };
    }

    try {
        const dateStr = new Date().toISOString().split("T")[0];
        const query = `query GetWorkerStats($accountId: String!, $date: String!) {
            viewer {
                accounts(filter: {accountTag: $accountId}) {
                    workersInvocationsAdaptive(limit: 1000, filter: {date: $date}) {
                        sum {
                            requests
                            subrequests
                        }
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
            body: JSON.stringify({
                query,
                variables: { accountId, date: dateStr }
            })
        });

        const data = await res.json();
        const sum = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0]?.sum;
        return {
            requests_today: sum?.requests || 0,
            subrequests_today: sum?.subrequests || 0,
            date: dateStr
        };
    } catch (e) {
        return { requests_today: 0, error: e.message };
    }
}

// -----------------------------------------------------------------------------
// موتور پردازش ترافیک (BPB Pattern Direct Streaming)
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
                // پارس اولیه و اتصال خروجی سوکت
                const parsed = parseInitialHeader(new Uint8Array(rawData));
                if (!parsed) {
                    server.close(1008, "Invalid protocol header");
                    return;
                }

                // آماده‌سازی مقصد اتصال (همراه با جایگاه ProxyIP)
                let targetAddress = parsed.address;
                let targetPort = parsed.port;

                if (dynamicConfig.proxyIP) {
                    targetAddress = dynamicConfig.proxyIP;
                }

                // برقراری ارتباط با مقصد از طریق کلادفلر سوکت
                remoteSocket = connect({
                    hostname: targetAddress,
                    port: targetPort
                });

                // ارسال باقیمانده بسته به مقصد
                if (parsed.payload && parsed.payload.length > 0) {
                    const writer = remoteSocket.writable.getWriter();
                    await writer.write(parsed.payload);
                    writer.releaseLock();
                }

                // پایپ کردن داده‌های دریافتی از سرور مقصد به کلاینت وب‌سوکت
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

// -----------------------------------------------------------------------------
// پارس پروتکل‌های VLESS و Trojan (پایه و سبک)
// -----------------------------------------------------------------------------
function parseInitialHeader(buffer) {
    if (buffer.length < 24) return null;

    // تشخیص هدر VLESS
    const version = buffer[0];
    if (version === 0) {
        let optLength = buffer[17];
        let cursor = 18 + optLength;
        const command = buffer[cursor]; // 1: TCP
        if (command !== 1) return null;
        cursor++;

        const port = (buffer[cursor] << 8) | buffer[cursor + 1];
        cursor += 2;

        const addressType = buffer[cursor];
        cursor++;

        let address = "";
        if (addressType === 1) { // IPv4
            address = `${buffer[cursor]}.${buffer[cursor+1]}.${buffer[cursor+2]}.${buffer[cursor+3]}`;
            cursor += 4;
        } else if (addressType === 2) { // Domain
            const domainLength = buffer[cursor];
            cursor++;
            address = new TextDecoder().decode(buffer.subarray(cursor, cursor + domainLength));
            cursor += domainLength;
        } else if (addressType === 3) { // IPv6
            const parts = [];
            for (let i = 0; i < 16; i += 2) {
                parts.push(((buffer[cursor + i] << 8) | buffer[cursor + i + 1]).toString(16));
            }
            address = parts.join(":");
            cursor += 16;
        }

        return {
            protocol: "vless",
            address,
            port,
            payload: buffer.subarray(cursor)
        };
    }

    // تشخیص هدر Trojan (در صورت شروع با کاراکترهای دیگر)
    // ساختار سبک هدر ترودان: 56 بایت هش SHA-224 + CRLF + Command + AddrType
    if (buffer.length > 58 && buffer[56] === 0x0D && buffer[57] === 0x0A) {
        let cursor = 58;
        const command = buffer[cursor]; // 1: Connect
        cursor++;
        const addressType = buffer[cursor];
        cursor++;

        let address = "";
        if (addressType === 1) { // IPv4
            address = `${buffer[cursor]}.${buffer[cursor+1]}.${buffer[cursor+2]}.${buffer[cursor+3]}`;
            cursor += 4;
        } else if (addressType === 3) { // Domain
            const domainLength = buffer[cursor];
            cursor++;
            address = new TextDecoder().decode(buffer.subarray(cursor, cursor + domainLength));
            cursor += domainLength;
        }

        const port = (buffer[cursor] << 8) | buffer[cursor + 1];
        cursor += 2;

        // رد کردن CRLF انتهایی هدر ترودان
        if (buffer[cursor] === 0x0D && buffer[cursor+1] === 0x0A) {
            cursor += 2;
        }

        return {
            protocol: "trojan",
            address,
            port,
            payload: buffer.subarray(cursor)
        };
    }

    return null;
}

// -----------------------------------------------------------------------------
// پایپ استریم از خروجی TCP به کلاینت وب‌سوکت
// -----------------------------------------------------------------------------
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
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    }
}
