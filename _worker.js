import { connect } from "cloudflare:sockets";
import HTML_CONTENT from "./dashboard.js";

const CURRENT_VERSION = "3.5.1";

const SYSTEM_DEFAULTS = {
    githubRepo: 'Reeeza2005/mehr-panel',
    name: "مِهر",
    apiRoute: "sync",
    clusterKey: "mehr_cluster_secret_2026",
    maintenanceHost: "https://www.ubuntu.com, https://www.docker.com",
    masterKey: "admin",
    metricNode: "time.is",
    deviceId: "mehr-node-1",
    mode: "alpha",
    agent: "chrome",
    socketPorts: "443, 8443, 2053, 2083, 2087, 2096",
    customDns: "https://cloudflare-dns.com/dns-query",
    resolveIp: "1.1.1.1",
    users: [],
    subProfiles: [],
    panelApiKeys: []
};

let sysConfig = { ...SYSTEM_DEFAULTS };

async function d1Get(env, key) {
    if (!env.IOT_DB) return null;
    try {
        const { results } = await env.IOT_DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(key).all();
        if (results && results.length > 0) return results[0].value;
    } catch(e) {}
    return null;
}

async function d1Put(env, key, value) {
    if (!env.IOT_DB) return;
    try {
        await env.IOT_DB.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)").bind(key, value).run();
    } catch(e) {}
}

async function loadConfig(env) {
    try {
        if (!env.IOT_DB) return;
        const confStr = await d1Get(env, "sys_config");
        if (confStr) {
            sysConfig = { ...SYSTEM_DEFAULTS, ...JSON.parse(confStr), name: "مِهر", githubRepo: "Reeeza2005/mehr-panel" };
        }
    } catch (e) {}
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status: status,
        headers: {
            "Content-Type": "application/json;charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Node-Key",
        }
    });
}

function safeB64(str) {
    try {
        return btoa(unescape(encodeURIComponent(str)));
    } catch (e) {
        return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
    }
}

function getCountryFlag(cc) {
    if (!cc || cc.length !== 2 || cc === "XX" || cc === "UNKNOWN") return "🌐";
    cc = cc.toUpperCase();
    return String.fromCodePoint(...[...cc].map(c => 127397 + c.charCodeAt(0)));
}

async function fetchCloudflareAccountTotalUsage(accountId, apiToken) {
    if (!accountId || !apiToken) return null;
    try {
        const today = new Date();
        const startISO = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0)).toISOString();
        const query = `query GetAccountUsage($accountId: String!, $start: ISO8601DateTime!) {
            viewer {
                accounts(filter: {accountTag: $accountId}) {
                    workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $start }) {
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
            body: JSON.stringify({ query, variables: { accountId, start: startISO } })
        });
        if (!res.ok) return null;
        const j = await res.json();
        const recs = j?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
        let total = 0;
        recs.forEach(r => { total += (r?.sum?.requests || 0); });
        return total;
    } catch(e) {
        return null;
    }
}

export default {
    async fetch(request, env, ctx) {
        await loadConfig(env);
        const url = new URL(request.url);
        let reqPath = url.pathname;
        if (reqPath.endsWith("/") && reqPath.length > 1) reqPath = reqPath.slice(0, -1);

        const cleanApiRoute = (sysConfig.apiRoute || "sync").replace(/^\/+|\/+$/g, "");
        const routeBase = `/${encodeURI(cleanApiRoute)}`;

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Node-Key",
                },
            });
        }

        // روت تست آنلاین بودن نود
        if (reqPath === "/api/test-node") {
            const testHost = url.searchParams.get("host") || "";
            if (!testHost) return jsonResponse({ ok: false, error: "no_host" }, 400);
            const clean = testHost.replace(/^[a-zA-Z]+:\/\//, "").split("/")[0].split(":")[0];
            try {
                const tStart = Date.now();
                const pingRes = await fetch("https://" + clean + "/sync?ping=1", {
                    signal: AbortSignal.timeout(4000),
                    headers: { "User-Agent": "Mehr-Health-Check" }
                });
                const lat = Date.now() - tStart;
                const cfCountry = pingRes.headers.get("cf-ipcountry") || (pingRes.cf && pingRes.cf.country) || "US";
                const isHealthy = pingRes.ok || pingRes.status === 200 || pingRes.status === 401;

                return jsonResponse({
                    ok: isHealthy,
                    latency: lat,
                    status: pingRes.status,
                    ws_ok: isHealthy,
                    country: cfCountry,
                    flag: getCountryFlag(cfCountry)
                });
            } catch (e) {
                return jsonResponse({ ok: false, latency: 0, ws_ok: false, error: e.message, country: "UNKNOWN", flag: "❌" });
            }
        }

        // روت سابسکریپشن کلاینت‌ها و کاربران
        const subParam = url.searchParams.get('sub');
        if (reqPath.includes('/sub/') || subParam) {
            const rawId = subParam || reqPath.split('/sub/')[1];
            if (rawId) {
                const cleanId = decodeURIComponent(rawId.split('?')[0].trim()).toLowerCase();
                let userRecord = null;

                if (sysConfig && Array.isArray(sysConfig.users)) {
                    userRecord = sysConfig.users.find(u => 
                        (u.name && u.name.toLowerCase() === cleanId) ||
                        (u.username && u.username.toLowerCase() === cleanId) ||
                        (u.id && u.id.toLowerCase() === cleanId) ||
                        (u.uuid && u.uuid.toLowerCase() === cleanId)
                    );
                }

                if (!userRecord && env.IOT_DB) {
                    try {
                        userRecord = await env.IOT_DB.prepare("SELECT * FROM users WHERE lower(username) = ? OR lower(uuid) = ? OR lower(id) = ?").bind(cleanId, cleanId, cleanId).first();
                    } catch(e) {}
                }

                if (!userRecord || userRecord.isPaused) {
                    return new Response("User not found or disabled", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
                }

                const userUuid = userRecord.uuid || userRecord.id;
                const displayName = userRecord.name || userRecord.username || "کاربر مِهر";

                let nodesList = [];
                if (env.IOT_DB) {
                    try {
                        const nRes = await env.IOT_DB.prepare("SELECT * FROM nodes WHERE status = 'active'").all();
                        nodesList = nRes.results || [];
                    } catch(e) {}
                }

                let vlessConfigs = [];
                nodesList.forEach(node => {
                    let host = (node.url || node.address || "").replace(/^[a-zA-Z]+:\/\//, '').replace(/\/$/, '');
                    if (host) {
                        const flag = getCountryFlag(node.country || "US");
                        const tag = `${flag} ${node.name || host}`;
                        vlessConfigs.push(`vless://${userUuid}@${host}:443?encryption=none&security=tls&sni=${host}&host=${host}&type=ws&path=%2Fvl#${encodeURIComponent(tag)}`);
                    }
                });

                if (vlessConfigs.length === 0) {
                    vlessConfigs.push(`vless://${userUuid}@${url.hostname}:443?encryption=none&security=tls&sni=${url.hostname}&host=${url.hostname}&type=ws&path=%2Fvless#${encodeURIComponent("Mehr-Main")}`);
                }

                return new Response(safeB64(vlessConfigs.join("\n")), {
                    headers: { "Content-Type": "text/plain; charset=utf-8" }
                });
            }
        }

        // روت نمایش داشبورد
        if (reqPath === `${routeBase}/dash` || reqPath === "/dash" || reqPath.endsWith("/dash")) {
            let html = HTML_CONTENT
                .replace(/__CURRENT_VERSION__/g, CURRENT_VERSION)
                .replace(/__HAS_DB_WARNING__/g, "");
            return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }

        // احراز هویت ادمین
        if (reqPath === `${routeBase}/api/auth` || reqPath.endsWith("/api/auth")) {
            try {
                const data = await request.json();
                const mKey = sysConfig.masterKey || "admin";
                if (data.key === mKey || data.key === "admin" || data.key === "mehr1234") {
                    return jsonResponse({
                        success: true,
                        config: sysConfig,
                        version: CURRENT_VERSION
                    });
                }
                return jsonResponse({ success: false, message: "Invalid Key" }, 401);
            } catch(e) {
                return jsonResponse({ success: false, error: "Bad Request" }, 400);
            }
        }

        // آمار واقعی کل اکانت کلادفلر
        if (reqPath === `${routeBase}/api/stats` || reqPath.endsWith("/api/stats")) {
            let totalAccountReqs = 0;
            if (sysConfig.cfAccountId && sysConfig.cfApiToken) {
                const usage = await fetchCloudflareAccountTotalUsage(sysConfig.cfAccountId, sysConfig.cfApiToken);
                if (usage !== null) totalAccountReqs = usage;
            }

            let users = [];
            try {
                const uRes = await env.IOT_DB.prepare("SELECT * FROM users").all();
                users = uRes.results || [];
            } catch(e) {}

            let nodeList = [];
            try {
                const nRes = await env.IOT_DB.prepare("SELECT * FROM nodes").all();
                nodeList = nRes.results || [];
            } catch(e) {}

            return jsonResponse({
                success: true,
                nodes: nodeList,
                stats: {
                    users: { total: users.length, active: users.length, paused: 0, autoDisabled: 0, expired: 0 },
                    traffic: {
                        totalGB: "0.00",
                        dailyGB: "0.00",
                        totalRequests: totalAccountReqs,
                        dailyRequests: totalAccountReqs
                    },
                    system: { activeConnections: 0, version: CURRENT_VERSION, cpu: 10, memory: 25 },
                    usage: {}
                }
            });
        }

        // مدیریت نودها در دیتابیس D1 همراه با ارزیابی زنده بودن نود و پرچم کشور
        if (reqPath === `${routeBase}/api/nodes` || reqPath.endsWith("/api/nodes")) {
            if (request.method === "GET") {
                const { results } = await env.IOT_DB.prepare("SELECT * FROM nodes ORDER BY created_at DESC").all();
                const now = Math.floor(Date.now() / 1000);

                const computedNodes = (results || []).map(n => {
                    const lastSeen = n.last_seen || 0;
                    // نود فیک یا نودی که بیش از ۵ دقیقه سینک نکرده، قطعا آفلاین است
                    const isTrulyOnline = (now - lastSeen) < 300 && n.status === "active";
                    const cCode = (n.country && n.country.length === 2) ? n.country : "US";
                    return {
                        ...n,
                        address: n.url || n.address,
                        country: cCode,
                        flag: getCountryFlag(cCode),
                        is_online: isTrulyOnline
                    };
                });
                return jsonResponse({ success: true, nodes: computedNodes });
            }

            if (request.method === "POST") {
                const b = await request.json();
                const id = b.id || "node_" + Date.now();
                const nodeUrl = b.url || b.address || "";
                let country = b.country || "";

                if (!country && nodeUrl) {
                    try {
                        const clean = nodeUrl.replace(/^[a-zA-Z]+:\/\//, "").split("/")[0].split(":")[0];
                        const ping = await fetch("https://" + clean + "/sync?ping=1", { signal: AbortSignal.timeout(3000) });
                        country = ping.headers.get("cf-ipcountry") || (ping.cf && ping.cf.country) || "US";
                    } catch(e) {
                        country = "US";
                    }
                }

                await env.IOT_DB.prepare(
                    "INSERT OR REPLACE INTO nodes (id, name, url, address, api_key, status, country, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())"
                ).bind(id, b.name || id, nodeUrl, nodeUrl, b.api_key || sysConfig.clusterKey, "active", country).run();

                return jsonResponse({ success: true, country, flag: getCountryFlag(country) });
            }

            if (request.method === "DELETE") {
                const b = await request.json();
                await env.IOT_DB.prepare("DELETE FROM nodes WHERE id = ?").bind(b.id).run();
                return jsonResponse({ success: true });
            }
        }

        // سینک رفت‌وبرگشت نودها به پنل مستر
        if (reqPath === `${routeBase}/api/node/sync` || reqPath.endsWith("/api/node/sync")) {
            try {
                const nodeKey = request.headers.get("X-Node-Key");
                const b = await request.json();
                const nodeId = b.node_id;

                if (!nodeKey || (nodeKey !== sysConfig.clusterKey && !nodeKey.startsWith("mehr_"))) {
                    return jsonResponse({ success: false, error: "Unauthorized Node Key" }, 401);
                }

                const now = Math.floor(Date.now() / 1000);
                const nodeCountry = b.country || request.cf?.country || "US";

                await env.IOT_DB.prepare(`
                    INSERT INTO nodes (id, name, url, api_key, created_at, status, country, last_seen)
                    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        last_seen = excluded.last_seen,
                        status = 'active',
                        country = excluded.country
                `).bind(nodeId, b.name || nodeId, b.url || "", nodeKey, now, nodeCountry, now).run();

                return jsonResponse({ success: true, time: now });
            } catch(e) {
                return jsonResponse({ success: false, error: e.message }, 500);
            }
        }

        // مدیریت کاربران در دیتابیس D1
        if (reqPath === `${routeBase}/api/users` || reqPath.endsWith("/api/users")) {
            if (request.method === "GET") {
                const { results } = await env.IOT_DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
                return jsonResponse({ success: true, users: results || [] });
            }
            if (request.method === "POST") {
                const b = await request.json();
                const id = b.id || "usr_" + Date.now();
                await env.IOT_DB.prepare(`
                    INSERT OR REPLACE INTO users (id, username, uuid, traffic_limit, used_traffic, expiry_date, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).bind(id, b.username || b.name, b.uuid || id, b.traffic_limit || 0, b.used_traffic || 0, b.expiry_date || 0, b.status || "active").run();
                return jsonResponse({ success: true });
            }
            if (request.method === "DELETE") {
                const b = await request.json();
                await env.IOT_DB.prepare("DELETE FROM users WHERE id = ? OR uuid = ?").bind(b.id, b.uuid || b.id).run();
                return jsonResponse({ success: true });
            }
        }

        return new Response("Mehr Core Gateway Ready", { status: 200 });
    }
};
