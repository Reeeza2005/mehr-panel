import { connect } from "cloudflare:sockets";
import HTML_CONTENT from "./dashboard.html";

const CURRENT_VERSION = "3.0.3";

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

        // روت نمایش داشبورد
        
        // روت تحویل لینک سابسکریپشن (شناسایی نام کاربر + کارت HTML مرورگر + کانفیگ Base64 برای کلاینت‌ها)
        if (reqPath.includes('/sub/')) {
            const rawId = reqPath.split('/sub/')[1];
            if (rawId) {
                const cleanId = decodeURIComponent(rawId.split('?')[0].trim()).toLowerCase();
                let userRecord = null;

                // 1. جستجو در آرایه کاربران پیکربندی پنل
                if (sysConfig && Array.isArray(sysConfig.users)) {
                    userRecord = sysConfig.users.find(u => 
                        (u.name && u.name.toLowerCase() === cleanId) ||
                        (u.username && u.username.toLowerCase() === cleanId) ||
                        (u.id && u.id.toLowerCase() === cleanId) ||
                        (u.uuid && u.uuid.toLowerCase() === cleanId)
                    );
                }

                // 2. جستجو در دیتابیس D1 در صورت عدم یافتن در حافظه کانفیگ
                if (!userRecord && env.IOT_DB) {
                    try {
                        userRecord = await env.IOT_DB.prepare("SELECT * FROM users WHERE lower(username) = ? OR lower(uuid) = ? OR lower(id) = ?").bind(cleanId, cleanId, cleanId).first();
                    } catch(e) {}
                }

                if (!userRecord || userRecord.isPaused) {
                    return new Response("User not found or disabled", { 
                        status: 404,
                        headers: { "Content-Type": "text/plain; charset=utf-8" }
                    });
                }

                const userUuid = userRecord.uuid || userRecord.id;
                const displayName = userRecord.name || userRecord.username || "کاربر مِهر";

                // استخراج نودهای فعال
                let nodesList = [];
                if (sysConfig && Array.isArray(sysConfig.nodes)) {
                    nodesList = sysConfig.nodes.filter(n => n.status === 'active');
                }
                if (nodesList.length === 0 && env.IOT_DB) {
                    try {
                        const nRes = await env.IOT_DB.prepare("SELECT * FROM nodes WHERE status = 'active'").all();
                        nodesList = nRes.results || [];
                    } catch(e) {}
                }

                let vlessConfigs = [];
                for (const node of nodesList) {
                    let host = (node.url || node.host || "").replace(/^https?:\/\//, '').replace(/\/$/, '');
                    if (host) {
                        vlessConfigs.push(`vless://${userUuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&path=/vless#Mehr-${node.name || 'Node'}`);
                    }
                }

                // نود پیش‌فرض سرور مِهر
                vlessConfigs.push(`vless://${userUuid}@${url.host}:443?encryption=none&security=tls&sni=${url.host}&type=ws&path=/vless#Mehr-Default`);

                const accept = request.headers.get("accept") || "";
                const ua = (request.headers.get("user-agent") || "").toLowerCase();
                const isBrowser = accept.includes("text/html") && !ua.includes("v2ray") && !ua.includes("karing") && !ua.includes("clash") && !ua.includes("streisand");

                if (isBrowser) {
                    const usedBytes = userRecord.used_traffic || (userRecord.traffic ? userRecord.traffic.used : 0) || 0;
                    const limitBytes = userRecord.traffic_limit || (userRecord.limitTotalReq ? userRecord.limitTotalReq * 1024 * 1024 : 0) || 0;
                    const usedMB = (usedBytes / (1024 * 1024)).toFixed(1);
                    const limitMB = limitBytes > 0 ? (limitBytes / (1024 * 1024)).toFixed(0) + " MB" : "نامحدود";
                    const expTime = userRecord.expire_time || userRecord.expiryMs || 0;
                    const expStr = expTime > 0 ? new Date(expTime).toLocaleDateString('fa-IR') : "نامحدود";

                    const pageHtml = `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>اشتراک ${displayName}</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#090d16;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}.card{background:#131d2e;border-radius:24px;padding:32px;width:100%;max-width:420px;box-shadow:0 20px 40px rgba(0,0,0,0.6);border:1px solid #1e293b;text-align:center}h2{margin:0 0 8px;color:#38bdf8;font-size:1.5rem}.badge{display:inline-block;padding:6px 16px;border-radius:20px;background:rgba(56,189,248,.12);color:#38bdf8;font-weight:700;margin-bottom:24px}.row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #1e293b;font-size:.95rem}.btn{display:block;width:100%;box-sizing:border-box;margin-top:20px;padding:14px;border-radius:14px;background:#0284c7;color:#fff;text-decoration:none;font-weight:700;cursor:pointer;border:none;font-size:1rem;transition:background 0.2s}.btn:hover{background:#0369a1}</style></head><body><div class="card"><h2>پنل کاربری مِهر</h2><div class="badge">کاربر: ${displayName}</div><div class="row"><span>وضعیت:</span><span style="color:#4ade80;font-weight:bold;">فعال</span></div><div class="row"><span>مصرف:</span><span>${usedMB} MB / ${limitMB}</span></div><div class="row"><span>انقضا:</span><span>${expStr}</span></div><button class="btn" onclick="navigator.clipboard.writeText(window.location.href);alert('لینک اشتراک با موفقیت کپی شد!');">📋 کپی لینک برای نرم‌افزار</button></div></body></html>`;
                    return new Response(pageHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
                }

                return new Response(btoa(vlessConfigs.join('\n')), {
                    headers: {
                        "Content-Type": "text/plain; charset=utf-8",
                        "Subscription-Userinfo": `upload=0; download=${userRecord.used_traffic || 0}; total=${userRecord.traffic_limit || 0}; expire=${userRecord.expire_time || 0}`
                    }
                });
            }
        }

        if (reqPath === `${routeBase}/dash` || reqPath === "/dash" || reqPath.endsWith("/dash")) {
            let html = HTML_CONTENT
                .replace(/__CURRENT_VERSION__/g, CURRENT_VERSION)
                .replace(/__HAS_DB_WARNING__/g, "");
            return new Response(html, {
                headers: { "Content-Type": "text/html; charset=utf-8" },
            });
        }

        // احراز هویت ادمین
        if (reqPath === `${routeBase}/api/auth` || reqPath.endsWith("/api/auth")) {
            try {
                const data = await request.json();
                if (data.key === sysConfig.masterKey) {
                    let userList = [];
                    try {
                        const dbRes = await env.IOT_DB.prepare("SELECT * FROM users").all();
                        userList = dbRes.results || [];
                    } catch(e) {}

                    const profiles = userList.map(u => ({
                        id: u.uuid || u.id,
                        name: u.username || u.name || "User",
                        sync: `${new URL(request.url).origin}/${sysConfig.apiRoute || 'sync'}/sub/${u.uuid || u.id}`
                    }));

                    return jsonResponse({
                        success: true,
                        config: { ...sysConfig, users: userList },
                        profiles: profiles,
                        deviceId: "mehr-node-1",
                        network: { ip: "127.0.0.1", colo: "THR", loc: "Tehran, IR" },
                        version: CURRENT_VERSION
                    });
                }
                return jsonResponse({ success: false, message: "Invalid Key" }, 401);
            } catch(e) {
                return jsonResponse({ success: false, error: "Bad Request" }, 400);
            }
        }

        // تنظیمات کلی
        if (reqPath === `${routeBase}/api/update` || reqPath === `${routeBase}/api/sync` || reqPath.endsWith("/api/sync") || reqPath.endsWith("/api/update")) {
            try {
                const body = await request.json();
                if (body.config) {
                    sysConfig = { ...sysConfig, ...body.config, name: "مِهر" };
                    await d1Put(env, "sys_config", JSON.stringify(sysConfig));
                }
                return jsonResponse({ success: true, config: sysConfig });
            } catch(e) {
                return jsonResponse({ success: false, error: e.message }, 500);
            }
        }

        // مشخصات سیستم و آمار
        if (reqPath === `${routeBase}/api/stats` || reqPath.endsWith("/api/stats")) {
            const { results: userList } = await env.IOT_DB.prepare("SELECT * FROM users").all();
            const { results: nodeList } = await env.IOT_DB.prepare("SELECT * FROM nodes").all();
            return jsonResponse({
                success: true,
                users: userList || [],
                nodes: nodeList || [],
                stats: { total: (userList || []).length, online: (nodeList || []).length, upload: 0, download: 0 },
                device: { cpu: 8, memory: 30, uptime: "5 days" }
            });
        }

        if (reqPath === `${routeBase}/api/logs` || reqPath.endsWith("/api/logs")) {
            return jsonResponse({ success: true, logs: [] });
        }

        if (reqPath === `${routeBase}/api/keys` || reqPath.endsWith("/api/keys")) {
            return jsonResponse({ success: true, keys: sysConfig.panelApiKeys || [] });
        }

        // مدیریت نودها در دیتابیس رابطه‌ای D1
        if (reqPath === `${routeBase}/api/nodes` || reqPath.endsWith("/api/nodes")) {
            if (request.method === "GET") {
                const { results } = await env.IOT_DB.prepare("SELECT * FROM nodes ORDER BY created_at DESC").all();
                const now = Math.floor(Date.now() / 1000);
                const computedNodes = (results || []).map(n => ({
                    ...n,
                    is_online: (now - (n.last_seen || 0)) < (35 * 60)
                }));
                return jsonResponse({ success: true, nodes: computedNodes });
            }
            if (request.method === "POST") {
                const b = await request.json();
                const id = b.id || "node_" + Date.now();
                await env.IOT_DB.prepare(
                    "INSERT OR REPLACE INTO nodes (id, name, address, api_key, status, last_seen) VALUES (?, ?, ?, ?, ?, ?)"
                ).bind(id, b.name, b.address, b.api_key || sysConfig.clusterKey, "active", Math.floor(Date.now() / 1000)).run();
                return jsonResponse({ success: true });
            }
            if (request.method === "DELETE") {
                const b = await request.json();
                await env.IOT_DB.prepare("DELETE FROM nodes WHERE id = ?").bind(b.id).run();
                await env.IOT_DB.prepare("DELETE FROM node_traffic WHERE node_id = ?").bind(b.id).run();
                return jsonResponse({ success: true });
            }
        }

        // تبادل دوطرفه نود با ورکر اصلی
        if (reqPath === `${routeBase}/api/node/sync`) {
            try {
                const nodeKey = request.headers.get("X-Node-Key");
                const b = await request.json();
                const nodeId = b.node_id;

                if (!nodeKey || (nodeKey !== sysConfig.clusterKey && !nodeKey.startsWith("mehr_"))) {
                    return jsonResponse({ success: false, error: "Unauthorized Node Key" }, 401);
                }

                const now = Math.floor(Date.now() / 1000);
                await env.IOT_DB.prepare(
                    "UPDATE nodes SET last_seen = ?, status = ? WHERE id = ? OR api_key = ?"
                ).bind(now, "active", nodeId, nodeKey).run();

                if (b.user_traffic && Array.isArray(b.user_traffic)) {
                    for (const report of b.user_traffic) {
                        await env.IOT_DB.prepare(`
                            INSERT INTO node_traffic (user_uuid, node_id, bytes_uploaded, bytes_downloaded, last_update)
                            VALUES (?, ?, ?, ?, ?)
                            ON CONFLICT(user_uuid, node_id) DO UPDATE SET
                                bytes_uploaded = bytes_uploaded + excluded.bytes_uploaded,
                                bytes_downloaded = bytes_downloaded + excluded.bytes_downloaded,
                                last_update = excluded.last_update
                        `).bind(report.uuid, nodeId, report.up || 0, report.down || 0, now).run();

                        const delta = (report.up || 0) + (report.down || 0);
                        if (delta > 0) {
                            await env.IOT_DB.prepare(
                                "UPDATE users SET used_traffic = used_traffic + ? WHERE uuid = ?"
                            ).bind(delta, report.uuid).run();
                        }
                    }
                }

                const { results: blocked } = await env.IOT_DB.prepare(
                    "SELECT uuid FROM users WHERE status != 'active' OR (traffic_limit > 0 AND used_traffic >= traffic_limit)"
                ).all();

                return jsonResponse({
                    success: true,
                    time: now,
                    blocked_uuids: (blocked || []).map(u => u.uuid)
                });
            } catch(e) {
                return jsonResponse({ success: false, error: e.message }, 500);
            }
        }

        // مدیریت کاربران
        if (reqPath === `${routeBase}/api/users` || reqPath.endsWith("/api/users")) {
            if (request.method === "GET") {
                const { results } = await env.IOT_DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
                return jsonResponse({ success: true, users: results || [] });
            }
            if (request.method === "POST") {
                const b = await request.json();
                const id = b.id || "usr_" + Date.now();
                await env.IOT_DB.prepare(`
                    INSERT OR REPLACE INTO users 
                    (id, username, uuid, traffic_limit, used_traffic, expiry_date, status, block_porn, block_ads, block_social, anti_sanction, custom_settings)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).bind(
                    id, b.username, b.uuid, b.traffic_limit || 0, b.used_traffic || 0,
                    b.expiry_date || 0, b.status || "active",
                    b.block_porn ? 1 : 0, b.block_ads ? 1 : 0, b.block_social ? 1 : 0, b.anti_sanction ? 1 : 0,
                    b.custom_settings ? JSON.stringify(b.custom_settings) : null
                ).run();
                return jsonResponse({ success: true });
            }
            if (request.method === "DELETE") {
                const b = await request.json();
                await env.IOT_DB.prepare("DELETE FROM users WHERE id = ? OR uuid = ?").bind(b.id, b.uuid || b.id).run();
                await env.IOT_DB.prepare("DELETE FROM node_traffic WHERE user_uuid = ?").bind(b.uuid || b.id).run();
                return jsonResponse({ success: true });
            }
        }

        // مخزن آی‌پی‌های تمیز
        if (reqPath === `${routeBase}/api/clean-ips` || reqPath.endsWith("/api/clean-ips")) {
            if (request.method === "GET") {
                const { results } = await env.IOT_DB.prepare("SELECT * FROM clean_ips").all();
                return jsonResponse({ success: true, ips: results || [] });
            }
            if (request.method === "POST") {
                const b = await request.json();
                const id = b.id || "cip_" + Date.now();
                await env.IOT_DB.prepare("INSERT OR REPLACE INTO clean_ips (id, ip, operator, status) VALUES (?, ?, ?, ?)").bind(id, b.ip, b.operator || "ALL", "active").run();
                return jsonResponse({ success: true });
            }
            if (request.method === "DELETE") {
                const b = await request.json();
                await env.IOT_DB.prepare("DELETE FROM clean_ips WHERE id = ? OR ip = ?").bind(b.id, b.ip || b.id).run();
                return jsonResponse({ success: true });
            }
        }

        // سابسکریپشن کلاینت
        if (reqPath === routeBase) {
            const { results: activeUsers } = await env.IOT_DB.prepare("SELECT uuid FROM users WHERE status = 'active' LIMIT 1").all();
            const uuid = (activeUsers && activeUsers.length > 0) ? activeUsers[0].uuid : "mehr-default-uuid";
            const vlessUrl = `vless://${uuid}@1.1.1.1:443?encryption=none&security=tls&type=ws&host=${url.hostname}&path=%2F${sysConfig.apiRoute}#Mehr-Hub`;
            return new Response(btoa(vlessUrl), {
                headers: { "Content-Type": "text/plain;charset=utf-8" }
            });
        }

        return new Response("Mehr Gateway v3.0.2 Ready", { status: 200 });
    }
};
