export const DASHBOARD_HTML = `import { connect } from "cloudflare:sockets";
import HTML_CONTENT from "./dashboard.html";

const CURRENT_VERSION = "3.0.1";

const SYSTEM_DEFAULTS = {
    name: "مِهر",
    apiRoute: "sync",
    maintenanceHost: "https://www.ubuntu.com, https://www.docker.com",
    backupRelay: "",
    customRelay: "",
    masterKey: "admin",
    metricNode: "time.is",
    cleanIps: "",
    slaveNodes: "",
    deviceId: "mehr-node-1",
    mode: "alpha",
    agent: "chrome",
    socketPorts: "443, 8443, 2053, 2083, 2087, 2096",
    customDns: "https://cloudflare-dns.com/dns-query",
    resolveIp: "1.1.1.1",
    cascade: "",
    enableOpt1: false,
    enableOpt2: false,
    enableOpt3: false,
    enableOpt4: false,
    enableOpt5: false,
    enableOpt6: false,
    enableOpt7: false,
    enableOpt8: false,
    enableOpt9: false,
    routingRules: "",
    blockRules: "",
    warpEndpoints: "",
    warpKeys: "",
    warpConfig: "",
    warpPlusKey: "",
    warpAccount: "",
    outProxy: "",
    subExpiry: 0,
    subQuota: 0,
    activeSubQuota: 0,
    allowDirectIp: false,
    dynamicOutProxy: false,
    outProxyPool: "",
    outProxyType: "active",
    outProxyLatency: "",
    cleanIpLatency: "",
    cleanIpSortBy: "speed",
    cleanIpDnsMode: "system",
    cleanIpCountry: "ALL",
    cleanIpAutoUpdate: false,
    cleanIpUpdateInterval: "24",
    users: [],
    customPanelUrl: "",
    hubPanelUrl: "",
    tgToken: "",
    tgChatId: "",
    tgAdminId: "",
    syncApiKey: "",
    panelApiKeys: [],
    cfApiToken: "",
    cfAccountId: "",
    cfWorkerName: "",
    silentAlerts: false,
    alertCpu: true,
    alertBandwidth: true,
    alertWarp: true,
    alertDb: true,
    alertLogin: true,
    alertOutProxy: true,
    outProxyHealthAlert: false,
    tunnelType: "vless",
    vlessPort: "443",
    vlessSecurity: "tls",
    customCdnHost: "",
    customSni: "",
    wsPath: "",
    enableTls: true,
    enableEarlyData: false,
    maxEarlyData: 2048,
    enableFragment: false,
    fragmentPackets: "tlshello",
    fragmentLength: "100-200",
    fragmentInterval: "10-20",
    enableMux: false,
    muxConcurrency: 8,
    antiGfwMode: false,
    antiGfwPadding: true,
    enableNoise: false,
    noisePacketCount: "10-20",
    noisePacketSize: "10-30",
    noiseDelay: "5-15",
    subProfiles: [],
    clientDns: "",
    subFormat: "v2ray",
    enableSubEncryption: false,
    subEncryptionKey: "",
    allowPortOverride: false,
    enableDynamicRouting: false,
    routeIpRules: "",
    routeDomainRules: "",
    chainProxy: "",
    enableChainProxy: false,
    chainProxyType: "socks5",
    chainProxyServer: "",
    chainProxyPort: "",
    chainProxyUser: "",
    chainProxyPass: "",
    ipVersionPreference: "v4",
    dnsOverTls: false,
    dnsTlsServer: "",
    dnsCacheTtl: 300,
    enableDnsCache: true,
    trafficLimitTotal: 0,
    trafficResetDay: 1,
    subPageTheme: "dark",
    subPageCustomText: "",
    showQrCode: true,
    enableClash: true,
    enableSingbox: true,
    enableV2ray: true,
    enableLoon: false,
    enableSurge: false,
    enableShadowrocket: true,
};

let sysConfig = { ...SYSTEM_DEFAULTS };

function isPanelApiKey(key) {
    if (!key || !sysConfig.panelApiKeys || !Array.isArray(sysConfig.panelApiKeys)) return false;
    return sysConfig.panelApiKeys.some(k => k.key === key && k.active !== false);
}

function getAllProfiles() {
    let profiles = [{ name: "Default", id: "default" }];
    if (sysConfig.subProfiles && Array.isArray(sysConfig.subProfiles)) {
        for (let p of sysConfig.subProfiles) {
            if (p && p.name && p.name !== "Default") {
                profiles.push(p);
            }
        }
    }
    return profiles;
}

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
            const loaded = JSON.parse(confStr);
            sysConfig = { ...SYSTEM_DEFAULTS, ...loaded, name: "مِهر" };
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
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
    });
}

export default {
    async fetch(request, env, ctx) {
        await loadConfig(env);
        const url = new URL(request.url);
        let reqPath = url.pathname;
        if (reqPath.endsWith("/") && reqPath.length > 1) reqPath = reqPath.slice(0, -1);

        const routeBase = \`/\${encodeURI(sysConfig.apiRoute)}\`;

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                },
            });
        }

        // روت داشبورد اصلی
        if (reqPath === \`\${routeBase}/dash\`) {
            let html = HTML_CONTENT
                .replace(/__CURRENT_VERSION__/g, CURRENT_VERSION)
                .replace(/__HAS_DB_WARNING__/g, "");
            return new Response(html, {
                headers: { "Content-Type": "text/html; charset=utf-8" },
            });
        }

        // روت احراز هویت
        if (reqPath === \`\${routeBase}/api/auth\` || reqPath.endsWith("/api/auth")) {
            try {
                const data = await request.json();
                const loginKey = data.key || "";
                if (loginKey === sysConfig.masterKey || isPanelApiKey(loginKey)) {
                    return jsonResponse({
                        success: true,
                        config: sysConfig,
                        deviceId: "mehr-node-1",
                        network: { ip: "127.0.0.1", colo: "THR", loc: "Tehran, IR" },
                        usage: {},
                        sysUsage: {},
                        version: CURRENT_VERSION,
                        profiles: getAllProfiles().map(p => ({
                            name: p.name,
                            id: p.id,
                            sync: \`\${url.origin}/\${sysConfig.apiRoute}\${p.name === "Default" ? "" : "?sub=" + encodeURIComponent(p.name)}\`
                        }))
                    });
                }
                return jsonResponse({ success: false, message: "Invalid Key" }, 401);
            } catch(e) {
                return jsonResponse({ success: false, error: "Bad Request" }, 400);
            }
        }

        // ذخیره و همگام‌سازی تنظیمات
        if (reqPath === \`\${routeBase}/api/update\` || reqPath === \`\${routeBase}/api/sync\` || reqPath.endsWith("/api/sync") || reqPath.endsWith("/api/update")) {
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

        // کاربران
        if (reqPath === \`\${routeBase}/api/users\` || reqPath.endsWith("/api/users")) {
            if (request.method === "POST" || request.method === "PUT") {
                try {
                    const payload = await request.json();
                    if (payload.users) {
                        sysConfig.users = payload.users;
                        await d1Put(env, "sys_config", JSON.stringify(sysConfig));
                    }
                } catch(e) {}
            }
            return jsonResponse({ success: true, users: sysConfig.users || [] });
        }

        // آمار و مشخصات سرور
        if (reqPath === \`\${routeBase}/api/stats\` || reqPath.endsWith("/api/stats")) {
            return jsonResponse({
                success: true,
                users: sysConfig.users || [],
                stats: { total: 0, online: 0, upload: 0, download: 0 },
                device: { cpu: 10, memory: 35, uptime: "4 days" }
            });
        }

        // لاگ‌ها و کلیدها
        if (reqPath === \`\${routeBase}/api/logs\` || reqPath.endsWith("/api/logs")) {
            return jsonResponse({ success: true, logs: [] });
        }

        if (reqPath === \`\${routeBase}/api/keys\` || reqPath.endsWith("/api/keys")) {
            return jsonResponse({ success: true, keys: sysConfig.panelApiKeys || [] });
        }

        // سابسکریپشن کلاینت
        if (reqPath === routeBase) {
            const vlessUrl = \`vless://mehr-default-uuid@1.1.1.1:443?encryption=none&security=tls&type=ws&host=\${url.hostname}&path=%2F\${sysConfig.apiRoute}#Mehr-Node\`;
            return new Response(btoa(vlessUrl), {
                headers: { "Content-Type": "text/plain;charset=utf-8" }
            });
        }

        return new Response("Mehr Edge Core Ready", { status: 200 });
    }
};
`;
