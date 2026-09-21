
function getAllProfiles(targetSub = null) {
    let devId = (typeof activeDeviceId !== 'undefined' && activeDeviceId) ? activeDeviceId : (sysConfig.deviceId || "00000000-0000-0000-0000-000000000001");
    let list = [{ id: devId, name: "Default" }];
    if (sysConfig && Array.isArray(sysConfig.users)) {
        sysConfig.users.forEach(u => {
            if (u && u.name) {
                list.push({ id: u.id || devId, name: u.name });
            }
        });
    }
    return list;
}

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
        const subParam = url.searchParams.get('sub');
        if (reqPath.includes('/sub/') || subParam) {
            const rawId = subParam || reqPath.split('/sub/')[1];
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
                    const subscriptionUrl = (typeof env !== 'undefined' && env.SUBSCRIPTION_URL) || 'https://raw.githubusercontent.com/itsyebekhe/nahan/main/subscription.html';
                    try {
                        let html = '';
                        try {
                            const resp = await fetch(subscriptionUrl);
                            if (resp.ok) html = await resp.text();
                        } catch(e) {}

                        if (!html) {
                            html = await fetch('https://cdn.jsdelivr.net/gh/itsyebekhe/nahan@main/subscription.html').then(r => r.text()).catch(() => '');
                        }

                        const targetUser = userRecord || { name: displayName, id: userUuid };
                        const idClean = (targetUser.id || userUuid).replace(/-/g, '').toLowerCase();
                        const totalReqs = targetUser.traffic_used || 0;
                        const limitTotal = targetUser.limitTotalReq || targetUser.traffic_limit || 0;
                        const limitDaily = targetUser.limitDailyReq || 0;
                        const totalGb = (totalReqs / (1024 * 1024 * 1024)).toFixed(2);
                        const limitTotalGb = limitTotal ? (limitTotal / (1024 * 1024 * 1024)).toFixed(2) : '9999';
                        const dailyGb = "0.00";
                        const limitDailyGb = limitDaily ? (limitDaily / (1024 * 1024 * 1024)).toFixed(2) : '9999';
                        const totalPercent = limitTotal ? Math.min(100, (totalReqs / limitTotal) * 100).toFixed(1) : '0';
                        const dailyPercent = '0';

                        let expiryDateTxt = '2099-01-01';
                        let isExpired = false;
                        if (targetUser.expiryMs || targetUser.expire_time) {
                            const exp = targetUser.expiryMs || targetUser.expire_time;
                            expiryDateTxt = new Date(exp).toISOString().split('T')[0];
                            if (Date.now() > exp) isExpired = true;
                        }

                        let statusCode = 'active';
                        if (targetUser.isPaused) statusCode = 'paused';
                        else if (isExpired) statusCode = 'expired';
                        else if (limitTotal && totalReqs >= limitTotal) statusCode = 'limit';

                        let cleanUrl = new URL(url.href);
                        cleanUrl.searchParams.delete('flag');
                        cleanUrl.searchParams.delete('format');
                        cleanUrl.searchParams.delete('type');
                        cleanUrl.searchParams.delete('output');
                        cleanUrl.searchParams.delete('raw');

                        const syncNormal = cleanUrl.href;
                        const syncRaw = cleanUrl.href + (cleanUrl.href.includes('?') ? '&flag=a' : '?flag=a');

                        let totalProgress = limitTotal
                            ? `<div class="w-full rounded-full h-1.5 mt-3 overflow-hidden progress-bar-bg"><div class="h-1.5 rounded-full" style="background: var(--accent); width: ${totalPercent}%;"></div></div><p class="text-[10px] text-muted text-right mt-1.5" data-i18n="used">${totalPercent}% Used</p>`
                            : '<p class="text-[10px] text-muted mt-2" data-i18n="unlimitedPlan">Unlimited Plan</p>';

                        let dailyProgress = '<p class="text-[10px] text-muted mt-2" data-i18n="noDailyLimit">No Daily Limit</p>';

                        html = html.replace(/__USER_NAME__/g, targetUser.name || displayName);
                        html = html.replace(/__USER_ID__/g, targetUser.id || userUuid);
                        html = html.replace(/__STATUS_CODE__/g, statusCode);
                        html = html.replace(/__TOTAL_GB__/g, totalGb);
                        html = html.replace(/__LIMIT_TOTAL_GB__/g, limitTotalGb);
                        html = html.replace(/__TOTAL_PERCENT__/g, totalPercent);
                        html = html.replace(/__DAILY_GB__/g, dailyGb);
                        html = html.replace(/__LIMIT_DAILY_GB__/g, limitDailyGb);
                        html = html.replace(/__DAILY_PERCENT__/g, dailyPercent);
                        html = html.replace(/__EXPIRY_DATE__/g, expiryDateTxt);
                        html = html.replace(/__SYNC_NORMAL__/g, syncNormal);
                        html = html.replace(/__SYNC_RAW__/g, syncRaw);
                        html = html.replace(/__TOTAL_PROGRESS__/g, totalProgress);
                        html = html.replace(/__DAILY_PROGRESS__/g, dailyProgress);

                        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                    } catch(err) {
                        return new Response("Subscription load error: " + err.message, { status: 500 });
                    }
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

                                                            const defaultNode = {
                        name: 'Default',
                        server: url.host,
                        port: 443,
                        type: 'vless',
                        tls: true,
                        ws: true,
                        path: '/vless',
                        security: 'tls',
                        uuid: userList.length > 0 ? (userList[0].uuid || userList[0].id) : 'default-id'
                    };

                    const profiles = [defaultNode];
                    if (sysConfig.customNodes && Array.isArray(sysConfig.customNodes)) {
                        profiles.push(...sysConfig.customNodes);
                    }

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
                    if (Array.isArray(body.config.users)) {
                        try {
                            for (const u of body.config.users) {
                                const uid = u.id || u.uuid;
                                const uname = u.name || u.username || 'User';
                                if (uid) {
                                    await env.IOT_DB.prepare(
                                        "INSERT INTO users (id, username, uuid) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET username=excluded.username, uuid=excluded.uuid"
                                    ).bind(uid, uname, uid).run();
                                }
                            }
                        } catch(dbErr) {
                            console.error("D1 User Sync Error:", dbErr);
                        }
                    }
                }
                return jsonResponse({ success: true, config: sysConfig });
            } catch(e) {
                return jsonResponse({ success: false, error: e.message }, 500);
            }
        }

        // مشخصات سیستم و آمار
        if (reqPath === `${routeBase}/api/stats` || reqPath.endsWith("/api/stats")) {
            let userList = [];
            let nodeList = [];
            try {
                const uRes = await env.IOT_DB.prepare("SELECT * FROM users").all();
                userList = uRes.results || [];
            } catch(e) {}
            try {
                const nRes = await env.IOT_DB.prepare("SELECT * FROM nodes").all();
                nodeList = nRes.results || [];
            } catch(e) {}

            return jsonResponse({
                success: true,
                users: userList,
                nodes: [
                    { id: '00000000-0000-0000-0000-000000000001', name: 'Default', server: url.host, port: 443, type: 'vless', tls: true, ws: true, path: '/vless' },
                    ...nodeList
                ],
                stats: {
                    users: { total: userList.length, active: userList.length, paused: 0, autoDisabled: 0, expired: 0 },
                    traffic: { totalGB: 0, dailyGB: 0, totalRequests: 0, dailyRequests: 0 },
                    system: { activeConnections: 0, version: "3.5.0", cpu: 10, memory: 25 },
                    usage: {}
                }
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
