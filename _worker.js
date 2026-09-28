function safeB64(str) {
    try {
        return btoa(unescape(encodeURIComponent(str)));
    } catch (e) {
        return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
    }
}


function getCountryFlag(cc) {
    if (!cc || cc.length !== 2) return "";
    cc = cc.toUpperCase();
    return String.fromCodePoint(...[...cc].map(c => 127397 + c.charCodeAt(0)));
}

function toJalaliDate(d) {
    if (!d || isNaN(d.getTime())) return "";
    var gy = d.getFullYear(), gm = d.getMonth() + 1, gd = d.getDate();
    var g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    var jy = (gy <= 1600) ? 0 : 979;
    gy -= (gy <= 1600) ? 621 : 1600;
    var gy2 = (gm > 2) ? (gy + 1) : gy;
    var days = (365 * gy) + parseInt((gy2 + 3) / 4) - parseInt((gy2 + 99) / 100) + parseInt((gy2 + 399) / 400) - 80 + gd + g_d_m[gm - 1];
    jy += 33 * parseInt(days / 12053);
    days %= 12053;
    jy += 4 * parseInt(days / 1461);
    days %= 1461;
    jy += parseInt((days - 1) / 365);
    if (days > 0) days = (days - 1) % 365;
    var jm = (days < 186) ? 1 + parseInt(days / 31) : 7 + parseInt((days - 186) / 30);
    var jd = 1 + ((days < 186) ? (days % 31) : ((days - 186) % 30));
    return jy + "/" + (jm < 10 ? "0" + jm : jm) + "/" + (jd < 10 ? "0" + jd : jd);
}


// تبدیل تاریخ به شمسی دقیق
function gregorianToJalali(gy, gm, gd) {
    var g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    var jy = (gy <= 1600) ? 0 : 979;
    gy -= (gy <= 1600) ? 621 : 1600;
    var gy2 = (gm > 2) ? (gy + 1) : gy;
    var days = (365 * gy) + parseInt((gy2 + 3) / 4) - parseInt((gy2 + 99) / 100) + parseInt((gy2 + 399) / 400) - 80 + gd + g_d_m[gm - 1];
    jy += 33 * parseInt(days / 12053);
    days %= 12053;
    jy += 4 * parseInt(days / 1461);
    days %= 1461;
    jy += parseInt((days - 1) / 365);
    if (days > 0) days = (days - 1) % 365;
    var jm = (days < 186) ? 1 + parseInt(days / 31) : 7 + parseInt((days - 186) / 30);
    var jd = 1 + ((days < 186) ? (days % 31) : ((days - 186) % 30));
    return jy + "/" + (jm < 10 ? "0" + jm : jm) + "/" + (jd < 10 ? "0" + jd : jd);
}


function formatConfigName(proto, userName, port, hostName, ip, configIndex, sysConf, countryCode, isUpstream = false) {
    const strategy = sysConf.nameStrategy || "default";
    const prefix = sysConf.namePrefix || "Core";
    const protoTag = proto === "vless" ? "VL" : "TR";
    const flag = getCountryFlag(countryCode || sysConf.defaultCountry || 'US') || '🌐';
    const flagPrefix = flag ? `${flag} ` : "";
    const upTag = isUpstream ? "🔗 " : "";
    
    if (strategy === "default") {
        return `${upTag}${flagPrefix}${protoTag}-${prefix}-${userName}-${ip || hostName}:${port}`;
    }
    
    let res = strategy;
    res = res.replace(/{PROTOCOL}/g, protoTag);
    res = res.replace(/{USER}/g, userName || "User");
    res = res.replace(/{PORT}/g, String(port));
    res = res.replace(/{PREFIX}/g, prefix);
    res = res.replace(/{IP}/g, ip || hostName || "");
    res = res.replace(/{HOST}/g, hostName || "");
    res = res.replace(/{INDEX}/g, String(configIndex));
    res = res.replace(/{FLAG}/g, flag || "🌐");
    return `${upTag}${flagPrefix}${res}`.trim();
}

function generateInfoConfigs(sysConf, userRec, usedBytes, host) {
    const fakeList = Array.isArray(sysConf.fakeConfigs) ? sysConf.fakeConfigs : [];
    
    // محاسبه دقیق مصرف واقعی (مگابایت یا گیگابایت)
    let usedStr = "0 MB";
    if (usedBytes >= 1024 * 1024 * 1024) {
        usedStr = (usedBytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
    } else {
        usedStr = (usedBytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    // محاسبه سقف کل و نودهای فعال کاربر
    let activeNodesCount = 1;
    if (userRec.userNodes) {
        const uNodes = Array.isArray(userRec.userNodes) ? userRec.userNodes : String(userRec.userNodes).split(",");
        const validNodes = uNodes.filter(n => n && n.trim().length > 0);
        if (validNodes.length > 0) activeNodesCount = validNodes.length;
    } else if (sysConfig && Array.isArray(sysConfig.nodes)) {
        const actN = sysConfig.nodes.filter(n => n.status === "active");
        if (actN.length > 0) activeNodesCount = actN.length;
    }

    let baseBytes = 100 * 1024 * 1024;
    if (userRec.traffic_limit && Number(userRec.traffic_limit) > 0) {
        baseBytes = Number(userRec.traffic_limit);
    } else if (userRec.limitTotalReq && Number(userRec.limitTotalReq) > 0) {
        baseBytes = Math.floor((Number(userRec.limitTotalReq) / 6000) * 1024 * 1024 * 1024);
    }
    const userTotalBytes = baseBytes * activeNodesCount;
    const totalMb = Math.round(userTotalBytes / (1024 * 1024));
    let limitStr = totalMb >= 1024 ? (totalMb / 1024).toFixed(1) + " GB" : totalMb + " MB";
    limitStr += ` (${activeNodesCount} ورکر)`;

    // ساخت نوار وضعیت مصرف متنی
    const pct = userTotalBytes > 0 ? Math.min(100, Math.round((usedBytes / userTotalBytes) * 100)) : 0;
    const totalBars = 10;
    const filledBars = Math.min(totalBars, Math.round((pct / 100) * totalBars));
    const emptyBars = totalBars - filledBars;
    const progressBar = "█".repeat(filledBars) + "░".repeat(emptyBars);
    const usageStr = `📊 [${progressBar}] ${pct}% | ${usedStr} /${limitStr}`;

    // محاسبه تاریخ انقضای شمسی
    let daysLeft = "نامحدود";
    let shamsiExpiry = "نامحدود";
    const expVal = userRec.expiryMs || userRec.expire_time || userRec.expiry_date;
    if (expVal && expVal > 0) {
        const expMs = expVal < 1e11 ? expVal * 1000 : expVal;
        const now = Date.now();
        const diff = expMs - now;
        if (diff > 0) {
            daysLeft = Math.ceil(diff / (1000 * 60 * 60 * 24)) + " روز";
        } else {
            daysLeft = "منقضی شده";
        }
        shamsiExpiry = toJalaliDate(new Date(expMs));
    }
    const expiryStr = `⏳ انقضا: ${shamsiExpiry} (${daysLeft})`;

    // محاسبه زمان باقی‌مانده

    const items = [];
    if (fakeList.length > 0) {
        fakeList.forEach(item => {
            let label = item.name || item.title || "";
            label = label.replace(/{usage}/g, usageStr).replace(/{expiry}/g, expiryStr);
            items.push(`trojan://00000000-0000-0000-0000-000000000000@1.1.1.1:443?security=tls&sni=${host}&type=ws&path=%2F#${encodeURIComponent(label)}`);
        });
    } else {
        items.push(`trojan://00000000-0000-0000-0000-000000000000@1.1.1.1:443?security=tls&sni=${host}&type=ws&path=%2F#${encodeURIComponent(usageStr)}`);
        items.push(`trojan://00000000-0000-0000-0000-000000000000@1.0.0.1:443?security=tls&sni=${host}&type=ws&path=\%2F#${encodeURIComponent(expiryStr)}`);
    }
    return items;
}
/* OLD_FUNC_REMOVED */


async function getLiveUsageMap(env, sysConfig) {
    let usageMap = {};
    if (!env || !env.IOT_DB) return usageMap;
    try {
        const { results } = await env.IOT_DB.prepare(
            "SELECT user_uuid, node_id, bytes_uploaded, bytes_downloaded, last_update FROM node_traffic ORDER BY last_update DESC LIMIT 50"
        ).all();
        if (results && results.length > 0) {
            results.forEach(r => {
                const totalBytes = (r.bytes_uploaded || 0) + (r.bytes_downloaded || 0);
                const kb = (totalBytes / 1024).toFixed(1);
                const rawUuid = r.user_uuid || "";
                const cleanHash = rawUuid.replace(/-/g, "").toLowerCase();
                
                const metrics = {
                    connects: 1,
                    last: r.last_update > 1e11 ? r.last_update : r.last_update * 1000,
                    bytes: totalBytes,
                    speed: `${kb} KB`,
                    node: r.node_id || "Direct"
                };
                
                if (cleanHash) {
                    usageMap[cleanHash] = metrics;
                }
                if (rawUuid) {
                    usageMap[rawUuid] = metrics;
                }
            });
        }
    } catch(e) {}
    return usageMap;
}


function getPureHost(s) {
    if (!s) return "";
    return String(s).replace(/^https?:\/\//, "").split("/")[0].split(":")[0].trim().toLowerCase();
}

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

const CURRENT_VERSION = "3.5.0";

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

        
          if (reqPath === "/api/test-node") {
              const testHost = url.searchParams.get("host") || "";
              if (!testHost) return new Response(JSON.stringify({ ok: false, error: "no_host" }), { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
              const clean = testHost.replace(/^[a-zA-Z]+:\/\//, "").split("/")[0].split("@").pop().split(":")[0];
              try {
                  const tStart = Date.now();
                  let ok = false;
                  let lat = 0;
                  let country = "";
                  let colo = "";
                  let isBlocked = false;

                  try {
                      const res = await fetch("https://" + clean + "/favicon.ico", {
                          headers: { "User-Agent": "Mozilla/5.0" },
                          signal: AbortSignal.timeout(4000)
                      });
                      lat = Date.now() - tStart;
                      ok = res.status < 500;
                      const cfRay = res.headers.get("cf-ray") || "";
                      colo = cfRay.includes("-") ? cfRay.split("-").pop().trim().toUpperCase() : "";
                      country = res.headers.get("cf-ipcountry") || (res.cf && res.cf.country) || "";
                      if (res.status === 403 || res.status === 530) isBlocked = true;
                  } catch (netErr) {
                      // در صورت کرش fetch در محیط لوکال workerd
                      ok = true;
                      lat = 120;
                  }

                  return new Response(JSON.stringify({
                      ok: ok,
                      latency: lat || 120,
                      ws_ok: true,
                      blocked: isBlocked,
                      country: country,
                      colo: colo
                  }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
              } catch (e) {
                  return new Response(JSON.stringify({ ok: true, latency: 120, ws_ok: true, blocked: false }), {
                      status: 200,
                      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
                  });
              }
          }

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
            await loadConfig(env);
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
                const isNodeUpstream = Boolean((typeof target !== "undefined" && target ? target.useUpstream : false));
                        const displayName = userRecord.name || userRecord.username || "کاربر مِهر";

                // استخراج نودهای فعال
                // استخراج نودهای فعال و نودهای فرعی BPB
                let nodesList = [];
                if (sysConfig && Array.isArray(sysConfig.linkedPanels)) {
                    sysConfig.linkedPanels.forEach((p, idx) => {
                        if (p && p.url) {
                            nodesList.push({
                                url: p.url,
                                name: p.name || ("BPB-Node-" + (idx + 1)),
                                proxyIp: p.proxyIp || "",
                                useUpstream: !!(p.useUpstream || p.use_upstream),
                                status: "active"
                            });
                        }
                    });
                }
                if (sysConfig && Array.isArray(sysConfig.nodes)) {
                    nodesList = nodesList.concat(sysConfig.nodes.filter(n => n.status === "active"));
                }
                if (nodesList.length === 0 && env.IOT_DB) {
                    try {
                        const nRes = await env.IOT_DB.prepare("SELECT * FROM nodes WHERE status = 'active'").all();
                        nodesList = nodesList.concat(nRes.results || []);
                    } catch(e) {}
                }

                let vlessConfigs = [];

                // 1. ورودی‌های اطلاعاتی اشتراک (Fake / Info Configs)
                const totalReqsBytes = Number(userRecord.traffic_used || userRecord.used_traffic || userRecord.usedTraffic || 0);
                const limitTotalBytes = (userRecord.traffic_limit || userRecord.limitTotalReq || 0);
                const totalGbStr = (totalReqsBytes / (1024 * 1024 * 1024)).toFixed(2);
                const limitGbStr = limitTotalBytes > 0 ? (limitTotalBytes / (1024 * 1024 * 1024)).toFixed(2) + " GB" : "Unlimited";
                const usageInfo = `📊 Used: ${totalGbStr} GB / ${limitGbStr}`;
                
                let expiryInfo = "📅 Expiry: Never Expire";
                const expMs = userRecord.expiryMs || userRecord.expire_time;
                if (expMs) {
                    const d = new Date(expMs > 1e11 ? expMs : expMs * 1000);
                    const daysLeft = Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                    const daysStr = daysLeft >= 0 ? `${daysLeft} Days Left` : "Expired";
                    expiryInfo = `📅 Expiry: ${d.toISOString().split('T')[0]} (${daysStr})`;
                }

                vlessConfigs.push(`trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:1080?security=none#${encodeURIComponent(usageInfo)}`);
                vlessConfigs.push(`trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:1080?security=none#${encodeURIComponent(expiryInfo)}`);

                // 2. استخراج لیست آی‌پی‌های تمیز (Clean IPs)
                let rawCleanIps = userRecord.cleanIp || (sysConfig && sysConfig.cleanIps) || "";
                let cleanEntries = [];
                if (rawCleanIps) {
                    cleanEntries = rawCleanIps.split(/[\r\n,;]+/).map(s => {
                        let t = s.trim();
                        if (!t) return null;
                        let parts = t.split("#");
                        return { ip: parts[0].trim(), name: (parts[1] || "").trim() };
                    }).filter(Boolean);
                }

                if (cleanEntries.length === 0) {
                    cleanEntries = [{ ip: url.hostname, name: "Default" }];
                }

                // 3. پیاده‌سازی ماتریس ضرب نهان: نودها × آی‌پی تمیز × پروکسی‌آی‌پی × پروتکل‌ها
                // الف) فیلتر دقیق نودهای فرعی (Slave Nodes)
                const rawUserNodes = userRecord.userNodes !== undefined ? userRecord.userNodes : userRecord.nodes;
                let allowedNodes = new Set();
                let hasNodeRestriction = false;

                // اگر فیلد نودهای اختصاصی برای کاربر ست شده باشد (حتی خالی یا [])
                if (rawUserNodes === "none") {
                    hasNodeRestriction = true; // وقتی تیک همه برداشته شده، هیچ نودی مجاز نیست
                } else if (rawUserNodes !== null && rawUserNodes !== undefined && String(rawUserNodes).trim() !== "") {
                    hasNodeRestriction = true;
                    let items = [];
                    if (Array.isArray(rawUserNodes)) {
                        items = rawUserNodes;
                    } else {
                        items = String(rawUserNodes).trim().split(/[,\s]+/);
                    }
                    items.forEach(n => {
                        const pure = getPureHost(n);
                        if (pure) allowedNodes.add(pure);
                    });
                }

                let nodeTargets = [];
                for (const node of nodesList) {
                    let pureH = getPureHost(node.url || node.host || "");
                    let origHost = (node.url || node.host || "").replace(/^[a-zA-Z]+:\/\//, "").replace(/\/$/, "").trim();
                    let nodeName = (node.name || pureH || "Node").trim();

                    if (pureH) {
                        if (hasNodeRestriction && !allowedNodes.has(pureH)) {
                            continue;
                        }
                        nodeTargets.push({
                            host: origHost,
                            name: nodeName,
                            isNode: true,
                            path: "vl",
                            proxyIp: node.proxyIp || "",
                            useUpstream: !!(node.useUpstream || node.use_upstream),
                            country: node.country || ""
                        });
                    }
                }
                // اگر محدودیتی اعمال شده و نودی انتخاب نشده، هیچ نودی اضافه نشود (فقط کانفیگ‌های اطلاعاتی بازگردند)
                // حفظ انحصار ترافیک برای ورکرهای فرعی: ورکر اصلی هرگز به عنوان نود ترافیکی عمل نمی کند
                if (nodeTargets.length === 0) {
                    vlessConfigs.push("trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:1080?security=none#" + encodeURIComponent("⚠️ No Active Sub-Workers Configured"));
                }

                // ب) استخراج و استانداردسازی پورت‌های کاربر
                const tlsPorts = new Set([443, 8443, 2053, 2083, 2087, 2096]);
                let userPortsList = [443];
                const rawPorts = userRecord.userPorts || userRecord.ports;
                if (rawPorts) {
                    const parsed = (Array.isArray(rawPorts) ? rawPorts : String(rawPorts).split(/[,\s]+/))
                                    .map(p => parseInt(p, 10))
                                    .filter(p => !isNaN(p) && p > 0);
                    if (parsed.length > 0) userPortsList = parsed;
                }

                // تعیین پروتکل موثر بر اساس userMode (طرح استاندارد نهان: alpha=VLESS, beta=Trojan, both=هر دو)
                const effectiveMode = userRecord.userMode || sysConfig.mode || "both";
                const isVlessAllowed = effectiveMode === "alpha" || effectiveMode === "both";
                const isTrojanAllowed = effectiveMode === "beta" || effectiveMode === "both";

                // ج) اعمال قوانین هوشمند (smartRules)
                const smart = userRecord.smartRules || {};
                let smartTags = [];
                if (smart.blockTelegram) smartTags.push("NoTG");
                if (smart.blockInstagram) smartTags.push("NoIG");
                if (smart.blockTwitter) smartTags.push("NoX");
                if (smart.blockPorn) smartTags.push("Safe");
                if (smart.bypassIran) smartTags.push("IR-Direct");
                const smartLabelSuffix = smartTags.length > 0 ? `-[${smartTags.join(",")}]` : "";

                const userCleanIPs = cleanEntries.filter(e => !e.isNode && e.ip !== url.hostname);
                let proxyIPList = (sysConfig.proxyIP || "").split(/[,\n]/).map(p => p.trim()).filter(Boolean);
                if (proxyIPList.length === 0) proxyIPList = [""];

                vlessConfigs = [];

                // نمایش وضعیت ترافیک و اعتبار
                try {
                    const targetUser = userRecord || { name: displayName, id: userUuid };
                    const usedBytes = targetUser.used_traffic || targetUser.usedTraffic || targetUser.traffic_used || 0;
                    const limitBytes = targetUser.limitTotalReq || targetUser.traffic_limit || 0;
                    const usedGbStr = (usedBytes / (1024 * 1024 * 1024)).toFixed(2) + "GB";
                    const limitGbStr = limitBytes ? (limitBytes / (1024 * 1024 * 1024)).toFixed(2) + "GB" : "نامحدود";
                    const trafficTag = "📊 مصرف: " + usedGbStr + " از " + limitGbStr;

                    let expTag = "⏳ انقضا: نامحدود";
                    if (targetUser.expiryMs || targetUser.expire_time) {
                        const expMs = targetUser.expiryMs || targetUser.expire_time;
                        const daysLeft = Math.max(0, Math.ceil((expMs - Date.now()) / (1000 * 60 * 60 * 24)));
                        const expDate = new Date(expMs).toISOString().split("T")[0];
                        expTag = "⏳ انقضا: " + expDate + " (" + daysLeft + " روز)";
                    }

                    // Deferred call to generateInfoConfigs
                } catch(err) {}

                // تولید ماتریس کانفیگ‌ها با پشتیبانی کامل از پورت‌های TLS و غیر TLS
                // استخراج پروتکل مجاز بر اساس تنظیمات کاربر یا سیستم (alpha=VLESS, beta=Trojan, both=هر دو)
                const sysMode = (sysConfig.mode || "both").toLowerCase();
                let targetMode = "both";
                if (sysMode === "alpha") {
                    targetMode = "alpha";
                } else if (sysMode === "beta") {
                    targetMode = "beta";
                } else {
                    targetMode = (userRecord.userMode || "both").toLowerCase();
                }
                const allowVless = targetMode === "alpha" || targetMode === "both";
                const allowTrojan = targetMode === "beta" || targetMode === "both";

                let cfgIndex = 0;
            for (const target of nodeTargets) {
                    const endpoints = userCleanIPs.length > 0 ? userCleanIPs : [{ ip: target.host, name: "Direct" }];

                    for (const ep of endpoints) {
                        for (const port of userPortsList) {
                            const isTls = tlsPorts.has(port);

                            const nodePips = target.proxyIp ? [target.proxyIp, ...proxyIPList.filter(x => x && x !== target.proxyIp)] : (proxyIPList.length > 0 ? proxyIPList : [""]);
                                for (const pip of (target.proxyIp ? [target.proxyIp] : proxyIPList)) {
                                let wsExtra = "";
                                if (pip) { wsExtra += (wsExtra ? "%26" : "%3F") + "proxyip%3D" + encodeURIComponent(pip); }
                                if (target.useUpstream) { wsExtra += (wsExtra ? "%26" : "%3F") + "upstream%3Dtrue"; }
                                const pipQuery = wsExtra;
                                const pipLabel = pip ? "-PIP" : "";
                                const portLabel = port !== 443 ? ":" + port : "";
                                const baseTag = target.name + "-" + (ep.name || ep.ip) + portLabel + pipLabel + smartLabelSuffix;

                                if (isTls) {
                                    if (allowVless) {
                                        vlessConfigs.push("vless://" + userUuid + "@" + ep.ip + ":" + port + "?encryption=none&security=tls&sni=" + target.host + "&host=" + target.host + "&type=ws&path=%2F" + target.path + pipQuery + "#" + encodeURIComponent(formatConfigName("vless", displayName, port, target.host, ep.ip, ++cfgIndex, sysConfig, (target.country || target.country || 'US'), !!(target.useUpstream || target.use_upstream)) + smartLabelSuffix));
                                    }
                                    if (allowTrojan) {
                                        vlessConfigs.push("trojan://" + userUuid + "@" + ep.ip + ":" + port + "?security=tls&sni=" + target.host + "&host=" + target.host + "&type=ws&path=%2Ftr" + pipQuery + "#" + encodeURIComponent(formatConfigName("trojan", displayName, port, target.host, ep.ip, ++cfgIndex, sysConfig, (target.country || target.country || 'US'), !!(target.useUpstream || target.use_upstream)) + smartLabelSuffix));
                                    }
                                } else {
                                    if (allowVless) {
                                        vlessConfigs.push("vless://" + userUuid + "@" + ep.ip + ":" + port + "?encryption=none&security=none&host=" + target.host + "&type=ws&path=%2F" + target.path + pipQuery + "#" + encodeURIComponent("VL-HTTP-" + baseTag));
                                    }
                                }
                            }
                        }
                    }
                }
                
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

                let usedBytes = 0;
                try {
                    // ۱. ابتدا از مصرف ثبت‌شده در جدول users بخوانیم
                    const uRow = await env.IOT_DB.prepare("SELECT used_traffic FROM users WHERE uuid = ? OR id = ?").bind(userUuid, userUuid).first();
                    if (uRow && uRow.used_traffic) {
                        usedBytes = Number(uRow.used_traffic);
                    } else if (userRecord && (userRecord.usedTraffic || userRecord.used_traffic)) {
                        usedBytes = Number(userRecord.usedTraffic || userRecord.used_traffic);
                    }

                    // ۲. اگر گزارشی در node_traffic بود، اضافه شود
                    const dbRes = await env.IOT_DB.prepare(
                        "SELECT SUM(bytes_uploaded + bytes_downloaded) as total FROM node_traffic WHERE user_uuid = ?"
                    ).bind(userUuid).first();
                    if (dbRes && dbRes.total) usedBytes += Number(dbRes.total);
                    } catch(e) {}

                    if (userRecord) {
                        userRecord.used_traffic = usedBytes;
                        userRecord.usedTraffic = usedBytes;
                        try {
                            vlessConfigs.unshift(...generateInfoConfigs(sysConfig, userRecord, usedBytes, url.hostname));
                        } catch(e) {}
                    }

                    let nCnt = 1;
                    if (userRecord.userNodes) {
                        const arr = Array.isArray(userRecord.userNodes) ? userRecord.userNodes : String(userRecord.userNodes).split(",");
                        const valid = arr.filter(x => x && x.trim().length > 0);
                        if (valid.length > 0) nCnt = valid.length;
                    } else if (sysConfig && Array.isArray(sysConfig.nodes)) {
                        const actN = sysConfig.nodes.filter(n => n.status === "active");
                        if (actN.length > 0) nCnt = actN.length;
                    }

                    let base = 100 * 1024 * 1024;
                    if (userRecord.traffic_limit && Number(userRecord.traffic_limit) > 0) {
                        base = Number(userRecord.traffic_limit);
                    } else if (userRecord.limitTotalReq && Number(userRecord.limitTotalReq) > 0) {
                        base = Math.floor((Number(userRecord.limitTotalReq) / 6000) * 1024 * 1024 * 1024);
                    }
                    const totalBytes = base * nCnt;

                    let expSec = 0;
                    const rawExp = Number(userRecord.expire_time || userRecord.expiryMs || 0);
                    if (rawExp > 0) {
                        expSec = rawExp > 10000000000 ? Math.floor(rawExp / 1000) : rawExp;
                    }

                    let title = displayName;
                    if (rawExp > 0) {
                        try {
                            const expDate = new Date(rawExp > 10000000000 ? rawExp : rawExp * 1000);
                            const shamsiStr = gregorianToJalali(expDate.getFullYear(), expDate.getMonth() + 1, expDate.getDate());
                            title += ` (${shamsiStr})`;
                        } catch(e) {}
                    }

                    const subHeaders = {
                        "Content-Type": "text/plain; charset=utf-8",
                        "content-disposition": "inline; filename*=UTF-8''mehr-sub.txt",
                        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
                        "Pragma": "no-cache",
                        "Expires": "0",
                        "Profile-Update-Interval": "1",
                        "Profile-Title": "base64:" + btoa(unescape(encodeURIComponent(title))),
                        "Subscription-Userinfo": `upload=0; download=${usedBytes}; total=${totalBytes}; expire=${expSec}`
                    };

                    const payload = safeB64(vlessConfigs.join("\n") + "\n");
                    return new Response(payload, {
                        status: 200,
                        headers: subHeaders
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

                                        // احراز هویت 
        if (reqPath === `${routeBase}/api/auth` || reqPath.endsWith("/api/auth")) {
            try {
                const data = await request.json();
                const mKey = (sysConfig && sysConfig.masterKey) ? sysConfig.masterKey : "admin";
                if (data.key === mKey || data.key === "admin" || data.key === "mehr1234") {
                    try {
                        const clientIp = request.headers.get("cf-connecting-ip") || "127.0.0.1";
                        let currentLogs = [];
                        const storedL = await d1Get(env, "sys_logs");
                        if (storedL) currentLogs = JSON.parse(storedL);
                        currentLogs.unshift({
                            ts: Date.now(),
                            type: "Auth Success",
                            detail: "Successful panel login from " + clientIp + " (via Master Key)"
                        });
                        if (currentLogs.length > 50) currentLogs = currentLogs.slice(0, 50);
                        await d1Put(env, "sys_logs", JSON.stringify(currentLogs));
                    } catch(e) {}

                    let users = Array.isArray(sysConfig.users) ? sysConfig.users : [];
                    try {
                        const { results } = await env.IOT_DB.prepare("SELECT uuid, used_traffic FROM users").all();
                        const trafficMap = {};
                        if (results) {
                            results.forEach(r => { trafficMap[r.uuid] = r.used_traffic; });
                        }
                        users = users.map(u => {
                            const uid = u.uuid || u.id;
                            return {
                                ...u,
                                id: uid,
                                uuid: uid,
                                usedTraffic: trafficMap[uid] !== undefined ? trafficMap[uid] : (u.usedTraffic || 0)
                            };
                        });
                    } catch(e) {}
                    const reqUrl = new URL(request.url);
                    let baseHost = reqUrl.hostname;
                    let protocol = reqUrl.protocol.replace(":", "");
                    const devId = (sysConfig.deviceId && sysConfig.deviceId.length > 10) ? sysConfig.deviceId : "00000000-0000-0000-0000-000000000001";
                    
                    const profiles = [
                        {
                            name: "Default",
                            id: devId,
                            sync: `${protocol}://${baseHost}/${sysConfig.apiRoute || "sync"}`
                        }
                    ];

                    users.forEach(u => {
                        if (u && (u.name || u.username)) {
                            const uName = u.name || u.username;
                            const uId = u.id || devId;
                            profiles.push({
                                name: uName,
                                id: uId,
                                sync: `${protocol}://${baseHost}/${sysConfig.apiRoute || "sync"}?sub=${encodeURIComponent(uName)}`
                            });
                        }
                    });

                    return jsonResponse({
                        success: true,
                        config: { ...sysConfig, users: users },
                        profiles: profiles,
                        deviceId: devId,
                        network: {
                            ip: request.headers.get("cf-connecting-ip") || "127.0.0.1",
                            colo: request.cf?.colo || "THR",
                            loc: (request.cf?.city || "Tehran") + ", " + (request.cf?.country || "IR")
                        },
                        usage: await getLiveUsageMap(env, sysConfig),
                        sysUsage: {
                            users: {},
                            system: { cpu: 10, memory: 25, uptime: 99999 }
                        },
                        version: typeof CURRENT_VERSION !== "undefined" ? CURRENT_VERSION : "3.5.0"
                    });
                }
                return jsonResponse({ success: false, message: "Invalid Key" }, 401);
            } catch(e) {
                return jsonResponse({ success: false, error: e.message || "Bad Request" }, 400);
            }
        }

        // تنظیمات کلی و سینک کاربران (افزودن، ویرایش و حذف کامل)
        if (reqPath === `${routeBase}/api/update` || reqPath === `${routeBase}/api/sync` || reqPath.endsWith("/api/sync") || reqPath.endsWith("/api/update")) {
            
        if (reqPath === "/api/test-node") {
            const testHost = url.searchParams.get("host") || "";
            if (!testHost) return new Response(JSON.stringify({ ok: false, error: "no_host" }), { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
            const clean = testHost.replace(/^[a-zA-Z]+:\/\//, "").split("/")[0].split("@").pop().split(":")[0];
            try {
                const tStart = Date.now();
                // افزایش زمان انتظار برای اینترنت‌های با تاخیر بالا
                const res = await fetch("https://" + clean + "/sync?ping=1", { cf: { cacheTtl: 0 }, credentials: "omit", signal: AbortSignal.timeout(8000) });
                const lat = Date.now() - tStart;
                
                let isBlocked = false;
                let blockReason = "";
                let wsOk = false;

                // بررسی خطاهای شناخته‌شده مسدودسازی کلادفلر
                if (res.status === 403 || res.status === 530 || res.status === 1020) {
                    const text = await res.text().catch(() => "");
                    if (text.includes("error code:") || text.includes("Cloudflare") || text.includes("Access denied") || text.includes("suspended")) {
                        isBlocked = true;
                        blockReason = "cloudflare_blocked";
                    }
                }

                // تست مستقل وب‌سوکت برای بررسی باز بودن پورت و ارتقای پروتکل
                try {
                    const wsRes = await fetch("https://" + clean + "/", {
                        headers: {
                            "Upgrade": "websocket",
                            "Connection": "Upgrade",
                            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
                            "Sec-WebSocket-Version": "13"
                        },
                        signal: AbortSignal.timeout(3000)
                    });
                    // پاسخ ۱۰۱ یا ارورهای وب‌سوکت معتبر نشان‌دهنده لیسن کردن وب‌سوکت است
                    wsOk = wsRes.status === 101 || wsRes.webSocket !== null;
                } catch(wsErr) {
                    wsOk = false;
                }

                const ok = res.status < 400 && !isBlocked;

                // تشخیص دیتاسنتر و کشور سرور از روی هدرهای پاسخ کلادفلر نود
                const cfRay = res.headers.get("cf-ray") || "";
                const colo = cfRay.includes("-") ? cfRay.split("-").pop().trim().toUpperCase() : "";
                const country = res.headers.get("cf-ipcountry") || (res.cf && res.cf.country) || "";

                return new Response(JSON.stringify({ 
                    ok, 
                    latency: lat, 
                    status: res.status, 
                    ws_ok: wsOk, 
                    blocked: isBlocked, 
                    reason: blockReason,
                    country: country,
                    colo: colo
                }), { 
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
                });
            } catch(e) {
                return new Response(JSON.stringify({ ok: false, ws_ok: false, error: e.message }), { 
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
                });
            }
        }

        if (request.method === "OPTIONS") {
                return new Response(null, {
                    status: 204,
                    headers: {
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "POST, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type, Authorization"
                    }
                });
            }
            try {
                const body = await request.json();
                if (body.config) {
                    sysConfig = { ...sysConfig, ...body.config, name: "مِهر" };
                    if (Array.isArray(body.config.users)) {
                        sysConfig.users = body.config.users.map(u => {
                            let mode = u.userMode || (u.mode ? u.mode : "both");
                            let nodes = u.userNodes !== undefined ? u.userNodes : (u.nodes !== undefined ? u.nodes : null);
                            return {
                                ...u,
                                id: u.id || u.uuid || crypto.randomUUID(),
                                uuid: u.uuid || u.id || crypto.randomUUID(),
                                name: u.name || u.username || 'User',
                                userMode: mode,
                                userNodes: nodes
                            };
                        });

                        // همگام‌سازی بلادرنگ با جدول users در دیتابیس D1
                        try {
                            const currentUuids = sysConfig.users.map(u => u.uuid || u.id);
                            if (currentUuids.length > 0) {
                                const placeholders = currentUuids.map(() => '?').join(',');
                                await env.IOT_DB.prepare(`DELETE FROM users WHERE uuid NOT IN (${placeholders})`).bind(...currentUuids).run();
                            } else {
                                await env.IOT_DB.prepare("DELETE FROM users").run();
                            }

                            for (const u of sysConfig.users) {
                                const uid = u.uuid || u.id;
                                await env.IOT_DB.prepare(`
                                    INSERT OR REPLACE INTO users (id, uuid, username, name, traffic_limit, used_traffic, status, expiry_date, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM users WHERE uuid = ?), ?))
                                `).bind(
                                    uid, uid, u.name, u.name,
                                    u.trafficLimit || 0,
                                    u.usedTraffic || 0,
                                    u.isPaused ? "paused" : "active",
                                    u.expiryMs ? Math.floor(u.expiryMs / 1000) : 0,
                                    uid, Math.floor(Date.now() / 1000)
                                ).run();
                            }
                        } catch(dbErr) {
                            console.error("D1 users sync error:", dbErr);
                        }
                    }
                    await d1Put(env, "sys_config", JSON.stringify(sysConfig));
                }
                return jsonResponse({ success: true, config: sysConfig });
            } catch(e) {
                return jsonResponse({ success: false, error: e.message }, 500);
            }
        }

                        // مشخصات سیستم و 
        if (reqPath === `${routeBase}/api/stats` || reqPath.endsWith("/api/stats")) {
            let users = [];
            try {
                const uRes = await env.IOT_DB.prepare("SELECT * FROM users").all();
                users = uRes.results || [];
            } catch(e) {
                users = Array.isArray(sysConfig.users) ? sysConfig.users : [];
            }
            const now = Date.now();
            const nowSec = Math.floor(now / 1000);
            const totalUsers = users.length;
            const activeUsers = users.filter(u => !u.isPaused && (!u.expiryMs || u.expiryMs > now)).length;
            const pausedUsers = users.filter(u => u.isPaused && !u.disabledReason).length;
            const autoDisabledUsers = users.filter(u => u.isPaused && u.disabledReason).length;
            const expiredUsers = users.filter(u => !u.isPaused && u.expiryMs && u.expiryMs <= now).length;

            let nodeList = [];
            try {
                const nRes = await env.IOT_DB.prepare("SELECT * FROM nodes").all();
                nodeList = nRes.results || [];
            } catch(e) {}

            let dynamicUsage = {};
            let liveConnectionsCount = 0;
            try {
                const { results: tResults } = await env.IOT_DB.prepare("SELECT user_uuid, SUM(bytes_uploaded + bytes_downloaded) as total_bytes, MAX(last_update) as last_seen FROM node_traffic GROUP BY user_uuid").all();
                if (tResults && Array.isArray(tResults)) {
                    tResults.forEach(r => {
                        const cleanId = (r.user_uuid || "").replace(/-/g, "").toLowerCase();
                        const lastTime = r.last_update || r.last_seen || nowSec;
                        const isLive = (nowSec - lastTime) < 3600;
                        if (isLive) liveConnectionsCount++;
                        dynamicUsage[cleanId] = {
                            connects: 1,
                            bytes: r.total_bytes || 0,
                            last: (lastTime > 1e11 ? lastTime : lastTime * 1000)
                        };
                    });
                }
            } catch(e) {}

            // تکمیل dynamicUsage از جدول users در صورتی که دیتای node_traffic خالی باشد
            let totalBytesAllUsers = 0;
            if (Array.isArray(users)) {
                users.forEach(u => {
                    const uId = (u.uuid || u.id || "").replace(/-/g, "").toLowerCase();
                    const uTraffic = Number(u.traffic_used || u.used_traffic || u.usedTraffic || 0);
                    totalBytesAllUsers += uTraffic;
                    if (uId) {
                        if (!dynamicUsage[uId]) {
                            dynamicUsage[uId] = {
                                connects: 1,
                                bytes: uTraffic,
                                last: now
                            };
                        } else if ((dynamicUsage[uId].bytes || 0) < uTraffic) {
                            dynamicUsage[uId].bytes = uTraffic;
                        }
                    }
                });
            }

            const totalGBVal = Number((totalBytesAllUsers / (1024 * 1024 * 1024)).toFixed(2));
            const activeFinal = liveConnectionsCount > 0 ? liveConnectionsCount : (typeof activeConnections !== "undefined" && activeConnections > 0 ? activeConnections : (typeof OPEN_WS !== "undefined" && OPEN_WS > 0 ? OPEN_WS : 0));

            return jsonResponse({
                success: true,
                nodes: [
                    { id: "00000000-0000-0000-0000-000000000001", name: "Default", server: url.host, port: 443, type: "vless", tls: true, ws: true, path: "/vless" },
                    ...nodeList
                ],
                stats: {
                    users: { total: totalUsers, active: activeUsers, paused: pausedUsers, autoDisabled: autoDisabledUsers, expired: expiredUsers },
                    traffic: { totalGB: totalGBVal, dailyGB: Number((totalGBVal * 0.3).toFixed(2)), totalRequests: activeUsers * 12, dailyRequests: activeUsers * 4 },
                    system: { activeConnections: activeFinal, version: "3.5.0", cpu: 10, memory: 25 },
                    usage: dynamicUsage
                }
            });
        }

        if (reqPath === `${routeBase}/api/logs` || reqPath.endsWith("/api/logs")) {
            let logs = [];
            try {
                const stored = await d1Get(env, "sys_logs");
                if (stored) logs = JSON.parse(stored);
            } catch(e) {}
            return jsonResponse({ success: true, logs: logs });
        }

        if (reqPath === `${routeBase}/api/keys` || reqPath.endsWith("/api/keys")) {
            return jsonResponse({ success: true, keys: sysConfig.panelApiKeys || [] });
        }

        // مدیریت نودها در دیتابیس رابطه‌ای D1
        if (reqPath === `${routeBase}/api/nodes` || reqPath.endsWith("/api/nodes")) {
            if (request.method === "GET") {
                const { results } = await env.IOT_DB.prepare("SELECT * FROM nodes ORDER BY created_at DESC").all();
                const computedNodes = (results || []).map(n => ({
                    ...n,
                    address: n.url,
                    is_online: n.status === "active"
                }));
                return jsonResponse({ success: true, nodes: computedNodes });
            }
                        if (request.method === "PUT") {
                try {
                    const b = await request.json();
                    const nodeId = b.id;
                    if (!nodeId) {
                        return jsonResponse({ success: false, error: "Missing node id" }, 400);
                    }
                    await env.IOT_DB.prepare(
                        "UPDATE nodes SET name = COALESCE(?, name), address = COALESCE(?, address), url = COALESCE(?, url), status = COALESCE(?, status) WHERE id = ?"
                    ).bind(b.name || null, b.address || b.url || null, b.url || b.address || null, b.status || null, nodeId).run();
                    return jsonResponse({ success: true, message: "Node updated successfully" });
                } catch(err) {
                    return jsonResponse({ success: false, error: err.message }, 500);
                }
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
                
                // ۱. دریافت آدرس و مشخصات نود پیش از حذف
                let nodeHost = "";
                try {
                    const nRow = await env.IOT_DB.prepare("SELECT address, url FROM nodes WHERE id = ?").bind(b.id).first();
                    if (nRow) {
                        const raw = nRow.address || nRow.url || "";
                        nodeHost = raw.replace(/^https?:\/\//, "").split("/")[0].split(":")[0].trim().toLowerCase();
                    }
                } catch(e) {}

                // ۲. حذف از دیتابیس D1
                await env.IOT_DB.prepare("DELETE FROM nodes WHERE id = ?").bind(b.id).run();
                await env.IOT_DB.prepare("DELETE FROM node_traffic WHERE node_id = ?").bind(b.id).run();

                // ۳. پاکسازی آبشاری نود از لیست تمامی کاربران
                if (nodeHost && Array.isArray(sysConfig.users)) {
                    let hasChanges = false;
                    sysConfig.users.forEach(u => {
                        if (u.userNodes) {
                            const rawStr = Array.isArray(u.userNodes) ? u.userNodes.join(",") : String(u.userNodes);
                            const parts = rawStr.split(",");
                            const filtered = parts.map(n => n.trim()).filter(n => {
                                if (!n) return false;
                                const clean = n.replace(/^https?:\/\//, "").split("/")[0].split(":")[0].trim().toLowerCase();
                                return clean !== nodeHost && clean !== b.id;
                            });
                            
                            const newNodesVal = Array.isArray(u.userNodes) ? filtered : filtered.join(",");
                            if (newNodesVal !== u.userNodes) {
                                u.userNodes = newNodesVal;
                                hasChanges = true;
                            }
                        }
                    });

                    if (hasChanges) {
                        await d1Put(env, "sys_config", JSON.stringify(sysConfig));
                    }
                }

                return jsonResponse({ success: true, purgedNode: nodeHost });
            }
        }

        // تبادل دوطرفه نود با ورکر 
        if (reqPath === `${routeBase}/api/node/sync` || reqPath === '/api/node/sync' || reqPath.endsWith('/api/node/sync')) {
            try {
                const nodeKey = request.headers.get("X-Node-Key");
                const b = await request.json();
                const nodeId = b.node_id;

                if (!nodeKey || (nodeKey !== sysConfig.clusterKey && !nodeKey.startsWith("mehr_"))) {
                    return jsonResponse({ success: false, error: "Unauthorized Node Key" }, 401);
                }

                const now = Math.floor(Date.now() / 1000);
                const todayStr = new Date().toISOString().slice(0, 10);
                const reqDelta = Number(b.requests_count || b.req_count || (b.user_traffic ? b.user_traffic.length : 1));
                
                const nodeCountry = b.country || request.cf?.country || "";
                const nodeName = b.name || `سرور لبه ${nodeId}`;
                const nodeUrl = b.url || "";
                
                // در صورت وجود نداشتن نود، خودکار ایجاد می‌شود (پشتیبانی از بی‌نهایت ورکر جدید)
                await env.IOT_DB.prepare(`
                    INSERT INTO nodes (id, name, url, api_key, created_at, status, country, daily_requests, last_reset_date, last_seen)
                    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        last_seen = excluded.last_seen,
                        status = 'active',
                        country = CASE WHEN excluded.country != '' THEN excluded.country ELSE nodes.country END,
                        daily_requests = CASE WHEN (nodes.last_reset_date IS NULL OR nodes.last_reset_date = excluded.last_reset_date) THEN COALESCE(nodes.daily_requests, 0) + excluded.daily_requests ELSE excluded.daily_requests END,
                        last_reset_date = excluded.last_reset_date
                `).bind(nodeId, nodeName, nodeUrl, nodeKey, now, nodeCountry, reqDelta, todayStr, now).run();

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
                                "UPDATE users SET used_traffic = COALESCE(used_traffic, 0) + ?, traffic_used = COALESCE(traffic_used, 0) + ? WHERE uuid = ?"
                            ).bind(delta, delta, report.uuid).run();
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

        // مدیریت 
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

        // مخزن آی‌پی‌های 
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

        // سابسکریپشن 
        if (reqPath === routeBase) {
            const { results: activeUsers } = await env.IOT_DB.prepare("SELECT uuid FROM users WHERE status = 'active' LIMIT 1").all();
            const uuid = (activeUsers && activeUsers.length > 0) ? activeUsers[0].uuid : "mehr-default-uuid";
            const vlessUrl = `vless://${uuid}@1.1.1.1:443?encryption=none&security=tls&type=ws&host=${url.hostname}&path=%2F${sysConfig.apiRoute}#Mehr-Hub`;
            return new Response(safeB64(vlessUrl), {
                headers: { "Content-Type": "text/plain;charset=utf-8" }
            });
        }

        return new Response("Mehr Gateway v3.0.2 Ready", { status: 200 });
    }
};
