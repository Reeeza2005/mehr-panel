const WIZARD_VERSION = "1.3.2";
// =============================================================================
// Mehr Unified Deployment Wizard (Multi-Account & Auto-Stats Edition)
// =============================================================================

const CORE_REPO = "Reeeza2005/mehr-panel";
const CORE_BRANCH = "main";

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === "/api/get-account" && request.method === "POST") {
            return await handleGetAccount(request);
        }

        if (url.pathname === "/api/deploy" && request.method === "POST") {
            return await handleDeploy(request);
        }

        return new Response(getWizardHtml(WIZARD_VERSION), {
            headers: { "Content-Type": "text/html; charset=utf-8" }
        });
    }
};

// -----------------------------------------------------------------------------
// اعتبارسنجی توکن و دریافت مشخصات اکانت
// -----------------------------------------------------------------------------
async function handleGetAccount(request) {
    try {
        const { apiToken } = await request.json();
        if (!apiToken) return jsonRes(false, "توکن کلادفلر الزامی است.");

        const res = await fetch("https://api.cloudflare.com/client/v4/accounts", {
            headers: { Authorization: `Bearer ${apiToken}` }
        });
        const data = await res.json();
        if (!data.success || !data.result || data.result.length === 0) {
            return jsonRes(false, "توکن نامعتبر است یا دسترسی به حساب کلادفلر ندارد.");
        }

        const accountId = data.result[0].id;
        const accountName = data.result[0].name;

        let workersList = [];
        try {
            const wRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`, {
                headers: { Authorization: `Bearer ${apiToken}` }
            });
            const wData = await wRes.json();
            if (wData.success && Array.isArray(wData.result)) {
                workersList = wData.result.map(w => ({ id: w.id }));
            }
        } catch (e) {}

        return jsonRes(true, "اکانت با موفقیت شناسایی شد.", {
            accountId,
            accountName,
            workers: workersList
        });
    } catch (err) {
        return jsonRes(false, err.message);
    }
}

// -----------------------------------------------------------------------------
// مدیریت عملیات دیپلوی
// -----------------------------------------------------------------------------
async function handleDeploy(request) {
    try {
        const { apiToken, accountId, targetType, workerName, masterPanelUrl, clusterKey } = await request.json();
        if (!apiToken || !accountId || !workerName || !targetType) {
            return jsonRes(false, "تمامی فیلدها الزامی هستند.");
        }

        const cleanName = workerName.toLowerCase().trim().replace(/[^a-z0-9-_]/g, "");

        if (targetType === "master") {
            return await deployMasterPanel(apiToken, accountId, cleanName);
        } else if (targetType === "edge") {
            return await deployEdgeNode(apiToken, accountId, cleanName, masterPanelUrl || "", clusterKey || "");
        } else {
            return jsonRes(false, "نوع عملیات نامعتبر است.");
        }
    } catch (err) {
        return jsonRes(false, err.message);
    }
}

// -----------------------------------------------------------------------------
// ۱. استقرار پنل اصلی (Master Panel)
// -----------------------------------------------------------------------------
async function deployMasterPanel(token, accountId, panelName) {
    const d1Id = await getOrCreateD1(accountId, token, "super_panel_db");

    try {
        const initSql = `
            CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS nodes (
                id TEXT PRIMARY KEY,
                name TEXT,
                url TEXT,
                address TEXT,
                api_key TEXT,
                status TEXT DEFAULT 'active',
                country TEXT,
                daily_requests INTEGER DEFAULT 0,
                last_reset_date TEXT,
                last_seen INTEGER DEFAULT 0,
                created_at INTEGER DEFAULT (unixepoch())
            );
            CREATE TABLE IF NOT EXISTS node_traffic (
                user_uuid TEXT,
                node_id TEXT,
                bytes_uploaded INTEGER DEFAULT 0,
                bytes_downloaded INTEGER DEFAULT 0,
                last_update INTEGER DEFAULT 0,
                PRIMARY KEY(user_uuid, node_id)
            );
            INSERT INTO kv_store (key, value) VALUES (
                'sys_config',
                json_object(
                    'cfAccountId', '${accountId}',
                    'cfWorkerName', '${panelName}',
                    'cfApiToken', '${token}',
                    'name', 'مِهر',
                    'apiRoute', 'sync',
                    'clusterKey', '${crypto.randomUUID().replace(/-/g, "")}'
                )
            ) ON CONFLICT(key) DO UPDATE SET
                value = json_set(value, '$.cfAccountId', '${accountId}', '$.cfWorkerName', '${panelName}', '$.cfApiToken', '${token}');
        `;
        await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${d1Id}/query`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ sql: initSql })
        });
    } catch (e) {}

    const masterWorkerSource = await fetchFromGithub("_worker.js");
    const masterHtmlSource = await fetchFromGithub("dashboard.html");

    const form = new FormData();
    const metadata = {
        main_module: "_worker.js",
        compatibility_date: "2024-09-01",
        compatibility_flags: ["nodejs_compat"],
        bindings: [
            { type: "d1", name: "IOT_DB", id: d1Id }
        ]
    };

    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    const dashboardJs = `export default ${JSON.stringify(masterHtmlSource)};`;
    const patchedWorker = masterWorkerSource.replace(/["']\.\/dashboard\.html["']/g, '"./dashboard.js"');

    form.append("_worker.js", new Blob([patchedWorker], { type: "application/javascript+module" }), "_worker.js");
    form.append("dashboard.js", new Blob([dashboardJs], { type: "application/javascript+module" }), "dashboard.js");

    const deployRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${panelName}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: form
    });

    const deployData = await deployRes.json();
    if (!deployData.success) {
        throw new Error(deployData.errors?.[0]?.message || "خطا در استقرار ورکر پنل اصلی.");
    }

    await enableWorkerSubdomain(accountId, token, panelName);
    const finalUrl = await getWorkerUrl(accountId, token, panelName, true);

    return jsonRes(true, "پنل اصلی با موفقیت مستقر شد.", {
        type: "master",
        url: finalUrl,
        name: panelName
    });
}

// -----------------------------------------------------------------------------
// ۲. استقرار نود لبه (Edge Ghost Node)
// -----------------------------------------------------------------------------
async function deployEdgeNode(token, accountId, nodeName, customMasterUrl = "", customClusterKey = "") {
    const nodeApiKey = "mehr_sec_" + crypto.randomUUID().replace(/-/g, "") + "_" + Math.random().toString(36).substring(2, 10);
    const agentSource = await fetchFromGithub("mehr-agent.js");

    let masterUrl = customMasterUrl.trim().replace(/\/+$/, "");
    let clusterSecret = (customClusterKey || "").trim();

    // تلاش برای خواندن خودکار تنظیمات از دیتابیس D1 همین اکانت
    try {
        const d1Id = await getOrCreateD1(accountId, token, "super_panel_db");
        const confRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${d1Id}/query`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ sql: "SELECT value FROM kv_store WHERE key = 'sys_config';" })
        });
        const confData = await confRes.json();
        const confRaw = confData?.result?.[0]?.results?.[0]?.value;
        if (confRaw) {
            const parsed = JSON.parse(confRaw);
            if (!clusterSecret && parsed.clusterKey) {
                clusterSecret = parsed.clusterKey;
            }
            if (!masterUrl) {
                const subRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                const subData = await subRes.json();
                const sub = subData?.result?.subdomain;
                if (parsed.cfWorkerName && sub) {
                    masterUrl = `https://${parsed.cfWorkerName}.${sub}.workers.dev`;
                }
            }
        }
    } catch (e) {}

    if (!masterUrl) {
        throw new Error("آدرس پنل مستر مشخص نیست. لطفاً آدرس پنل اصلی را در فرم وارد کنید.");
    }
    if (!clusterSecret) {
        throw new Error("کلید کلاستر (Cluster Key) یافت نشد. برای اتصال نود سفارشی، کلید کلاستر پنل الزامی است.");
    }

    const form = new FormData();
    const metadata = {
        main_module: "agent.js",
        compatibility_date: new Date().toISOString().split("T")[0],
        compatibility_flags: ["nodejs_compat"],
        bindings: [
            { type: "plain_text", name: "PANEL_URL", text: new URL(masterUrl.startsWith("http") ? masterUrl : `https://${masterUrl}`).origin },
            { type: "plain_text", name: "CLUSTER_KEY", text: clusterSecret },
            { type: "plain_text", name: "API_KEY", text: nodeApiKey },
            { type: "plain_text", name: "NODE_ID", text: nodeName },
            { type: "plain_text", name: "CF_ACCOUNT_ID", text: accountId },
            { type: "plain_text", name: "CF_API_TOKEN", text: token }
        ]
    };

    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("agent.js", new Blob([agentSource], { type: "application/javascript+module" }), "agent.js");

    const deployRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${nodeName}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: form
    });

    const deployData = await deployRes.json();
    if (!deployData.success) {
        throw new Error(deployData.errors?.[0]?.message || "خطا در استقرار نود لبه.");
    }

    await enableWorkerSubdomain(accountId, token, nodeName);
    const finalUrl = await getWorkerUrl(accountId, token, nodeName, false);

    try {
        const d1Id = await getOrCreateD1(accountId, token, "super_panel_db");
        const cleanHost = finalUrl.replace(/^https?:\/\//, "").split("/")[0];
        const insertSql = `INSERT OR REPLACE INTO nodes (id, name, url, address, api_key, status, created_at, last_seen) 
                           VALUES ('${nodeName}', '${nodeName}', '${finalUrl}', '${cleanHost}', '${nodeApiKey}', 'active', unixepoch(), unixepoch());`;
        await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${d1Id}/query`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ sql: insertSql })
        });
    } catch (dbErr) {}

    return jsonRes(true, "نود فرعی با موفقیت دیپلوی و به پنل متصل شد.", {
        type: "edge",
        url: finalUrl,
        apiKey: nodeApiKey,
        name: nodeName
    });
}

// -----------------------------------------------------------------------------
// توابع کمکی ارتباط با کلادفلر و گیت‌‌هاب
// -----------------------------------------------------------------------------
async function getOrCreateD1(accountId, token, dbName) {
    const listRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const listData = await listRes.json();
    if (listData.success && listData.result) {
        const found = listData.result.find(db => db.name === dbName);
        if (found) return found.uuid;
    }

    const createRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: dbName })
    });
    const createData = await createRes.json();
    if (!createData.success) {
        throw new Error(createData.errors?.[0]?.message || "خطا در ایجاد دیتابیس D1.");
    }
    return createData.result.uuid;
}

async function fetchFromGithub(filePath) {
    const rawUrl = `https://raw.githubusercontent.com/${CORE_REPO}/${CORE_BRANCH}/${filePath}?_t=${Date.now()}`;
    const res = await fetch(rawUrl, {
        headers: {
            "User-Agent": "Mehr-Wizard-Installer",
            "Accept": "text/plain",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache"
        }
    });
    if (!res.ok) {
        throw new Error(`خطا در دریافت ${filePath} از گیت‌هاب (کد وضعیت: ${res.status})`);
    }
    return await res.text();
}

async function enableWorkerSubdomain(accountId, token, scriptName) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true })
    });
    const d = await res.json();
    if (!d.success && d.errors?.[0]?.code !== 10014) {
        throw new Error("خطا در فعال‌سازی ساب‌دامین workers.dev: " + (d.errors?.[0]?.message || "نامشخص"));
    }
    return true;
}

async function getWorkerUrl(accountId, token, scriptName, isMasterPanel = false) {
    const subRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const subData = await subRes.json();
    const subdomain = subData?.result?.subdomain;
    if (!subdomain) {
        throw new Error("ساب‌دامین اختصاصی اکانت کلادفلر یافت نشد.");
    }
    const base = `https://${scriptName}.${subdomain}.workers.dev`;
    return isMasterPanel ? `${base}/sync/dash` : base;
}

function jsonRes(success, message, data = null) {
    return new Response(JSON.stringify({ success, message, data }), {
        headers: { "Content-Type": "application/json; charset=utf-8" }
    });
}

function getWizardHtml(version = WIZARD_VERSION) {
    return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mehr Setup Wizard v${version}</title>
    <style>
        :root {
            --bg: #090d16;
            --card: #131b2e;
            --border: #233354;
            --primary: #38bdf8;
            --primary-hover: #0ea5e9;
            --text: #f1f5f9;
            --text-muted: #94a3b8;
            --success: #10b981;
            --danger: #ef4444;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
        body {
            background-color: var(--bg);
            color: var(--text);
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 20px;
        }
        .card {
            background-color: var(--card);
            border: 1px solid var(--border);
            border-radius: 16px;
            width: 100%;
            max-width: 540px;
            padding: 32px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.5);
        }
        .badge {
            display: inline-block;
            background: rgba(56, 189, 248, 0.1);
            color: var(--primary);
            padding: 4px 12px;
            border-radius: 9999px;
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 12px;
            border: 1px solid rgba(56, 189, 248, 0.2);
        }
        h1 { font-size: 20px; margin-bottom: 8px; }
        p { color: var(--text-muted); font-size: 13px; line-height: 1.6; margin-bottom: 20px; }
        .token-helper {
            background: rgba(56, 189, 248, 0.05);
            border: 1px dashed rgba(56, 189, 248, 0.3);
            border-radius: 10px;
            padding: 12px;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .token-helper span { font-size: 12px; color: var(--text-muted); }
        .btn-link {
            background: rgba(56, 189, 248, 0.2);
            color: var(--primary);
            padding: 6px 12px;
            border-radius: 6px;
            text-decoration: none;
            font-size: 12px;
            font-weight: 600;
            white-space: nowrap;
            transition: all 0.2s;
        }
        .btn-link:hover { background: var(--primary); color: #000; }
        .field { margin-bottom: 16px; }
        label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
        input, select {
            width: 100%;
            background: #1e293b;
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 12px;
            color: #fff;
            font-size: 13px;
            outline: none;
        }
        input { direction: ltr; }
        input:focus, select:focus { border-color: var(--primary); }
        .account-badge {
            font-size: 12px;
            color: var(--success);
            margin-top: 4px;
            display: none;
        }
        .btn {
            width: 100%;
            background: var(--primary);
            color: #031525;
            font-weight: 600;
            padding: 14px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 14px;
            margin-top: 8px;
            transition: all 0.2s;
        }
        .btn:hover { background: var(--primary-hover); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .result-box {
            margin-top: 24px;
            background: #080c14;
            border: 1px solid #1e293b;
            border-radius: 8px;
            padding: 16px;
            display: none;
        }
        .result-item { margin-bottom: 12px; }
        .result-label { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
        .result-val {
            background: #111827;
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-family: monospace;
            word-break: break-all;
            direction: ltr;
            text-align: left;
            border: 1px solid #1f2937;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .copy-btn {
            background: #1f2937;
            color: var(--primary);
            border: none;
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 11px;
            cursor: pointer;
            margin-right: 8px;
        }
        .status { margin-top: 12px; font-size: 13px; text-align: center; }
        .status.error { color: var(--danger); }
        .status.success { color: var(--success); }
    </style>
</head>
<body>
    <div class="card">
        <span class="badge">Mehr Deployment Hub</span>
        <h1>ویزارد جامع راه‌اندازی کلاستر مهر <span style="font-size: 13px; background: #2563eb; color: #fff; padding: 2px 8px; border-radius: 9999px; margin-right: 8px; vertical-align: middle;">v${version}</span></h1>
        <p>پنل اصلی یا نودهای فرعی را با یک کلیک و بدون نیاز به ترمینال دیپلوی یا به‌روزرسانی کنید.</p>

        <div class="token-helper">
            <span>نیاز به ساخت یا بررسی توکن دارید؟</span>
            <a href="https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[{%22key%22:%22workers_scripts%22,%22type%22:%22edit%22},{%22key%22:%22workers_kv_storage%22,%22type%22:%22edit%22},{%22key%22:%22d1%22,%22type%22:%22edit%22},{%22key%22:%22account_settings%22,%22type%22:%22read%22},{%22key%22:%22analytics%22,%22type%22:%22read%22},{%22key%22:%22dns%22,%22type%22:%22edit%22},{%22key%22:%22workers_routes%22,%22type%22:%22edit%22},{%22key%22:%22zone%22,%22type%22:%22read%22}]&name=Mehr+Hub+Token" target="_blank" class="btn-link">🔑 ساخت خودکار توکن</a>
        </div>

        <div class="field">
            <label>Cloudflare API Token</label>
            <input type="password" id="apiToken" placeholder="توکن اکانت مورد نظر را پیست کنید" oninput="detectAccount()">
            <div class="account-badge" id="accountBadge"></div>
        </div>

        <div class="field">
            <label>عملیات مورد نظر</label>
            <select id="targetType" onchange="updateTargetUI(); updateWorkerDropdown();">
                <option value="master">🚀 نصب / به‌‌روزرسانی پنل اصلی (Master Panel)</option>
                <option value="edge">👻 راه‌اندازی نود فرعی جدید (Ghost Edge Node)</option>
            </select>
        </div>

        <div class="field" id="masterUrlField" style="display:none;">
            <label>🌐 آدرس پنل اصلی مِهر (Master URL)</label>
            <input type="text" id="masterPanelUrl" placeholder="https://mehr.your-domain.workers.dev">
            <span style="font-size: 11px; color: var(--text-muted); display: block; margin-top: 4px;">آدرس کامل پنل مستر (در صورت استقرار در اکانت یکسان، خالی بگذارید تا خودکار شناسایی شود).</span>
        </div>

        <div class="field" id="clusterKeyField" style="display:none;">
            <label>🔑 کلید کلاستر پنل اصلی (Cluster Key)</label>
            <input type="text" id="clusterKeyInput" placeholder="اختیاری در اکانت یکسان / الزامی برای اکانت مجزا">
            <span style="font-size: 11px; color: var(--text-muted); display: block; margin-top: 4px;">در صورت نصب روی همین اکانت کلودفلر، سیستم کلید را خودکار از دیتابیس استخراج می‌کند.</span>
        </div>

        <div class="field">
            <label id="nameLabel">نام ورکر پنل اصلی</label>
            <select id="workerSelect" style="display:none; width:100%; margin-bottom:8px; padding:10px; border-radius:8px; border:1px solid var(--border, #334155); background-color:var(--surface, #1e293b); color:var(--text, #f8fafc); outline:none;" onchange="onWorkerSelected(this.value)">
                <option value="">-- انتخاب ورکر موجود جهت بروزرسانی یا نصب جدید --</option>
            </select>
            <input type="text" id="workerName" style="width:100%; padding:10px; border-radius:8px; border:1px solid var(--border, #334155); background-color:var(--surface, #1e293b); color:var(--text, #f8fafc); outline:none;" value="mehr" placeholder="نام ورکر">
        </div>

        <button class="btn" id="deployBtn" onclick="startDeploy()">⚡ شروع استقرار خودکار</button>
        <div class="status" id="statusMsg"></div>

        <div class="result-box" id="resultBox">
            <div class="result-item">
                <div class="result-label">🌐 آدرس ورکر مستقر شده:</div>
                <div class="result-val">
                    <span id="resUrl"></span>
                    <button class="copy-btn" onclick="copyText('resUrl')">کپی</button>
                </div>
            </div>
            <div class="result-item" id="keyBox">
                <div class="result-label">🔑 کلید اختصاصی نود (API Key جهت کنترل در پنل):</div>
                <div class="result-val">
                    <span id="resKey"></span>
                    <button class="copy-btn" onclick="copyText('resKey')">کپی</button>
                </div>
            </div>
            <p id="resultDesc" style="margin: 12px 0 0; color: #10b981; font-size: 12px;"></p>
        </div>
    </div>

    <script>
        let detectedAccountId = "";
        let cachedWorkers = [];

        function updateWorkerDropdown() {
            const sel = document.getElementById("workerSelect");
            const targetType = document.getElementById("targetType").value;
            if (!sel) return;

            if (!cachedWorkers.length) {
                sel.style.display = "none";
                return;
            }

            let filtered = [];
            if (targetType === "master") {
                filtered = cachedWorkers.filter(w => w.id.toLowerCase().includes("panel") || w.id.toLowerCase() === "mehr");
                if (filtered.length === 0) filtered = cachedWorkers;
            } else {
                filtered = cachedWorkers.filter(w => !w.id.toLowerCase().includes("panel") && w.id.toLowerCase() !== "mehr");
            }

            sel.innerHTML = '<option value="">-- انتخاب ورکر جهت بروزرسانی (' + filtered.length + ' مورد) --</option>';
            filtered.forEach(w => {
                const opt = document.createElement("option");
                opt.value = w.id;
                opt.innerText = "🔄 بروزرسانی: " + w.id;
                sel.appendChild(opt);
            });
            const newOpt = document.createElement("option");
            newOpt.value = "__new__";
            newOpt.innerText = "➕ ایجاد ورکر جدید با نام دلخواه...";
            sel.appendChild(newOpt);
            sel.style.display = "block";
        }

        function onWorkerSelected(val) {
            const input = document.getElementById("workerName");
            if (val === "__new__") {
                input.value = "";
                input.focus();
            } else if (val) {
                input.value = val;
            }
        }

        function updateTargetUI() {
            const type = document.getElementById("targetType").value;
            const nameInput = document.getElementById("workerName");
            const label = document.getElementById("nameLabel");
            const masterUrlField = document.getElementById("masterUrlField");

            if (type === "master") {
                label.innerText = "نام ورکر پنل اصلی";
                nameInput.value = "mehr";
                masterUrlField.style.display = "none";
            } else {
                label.innerText = "نام ورکر نود فرعی";
                nameInput.value = "node-edge-1";
                masterUrlField.style.display = "block";
            }
        }

        async function detectAccount() {
            const token = document.getElementById("apiToken").value.trim();
            const badge = document.getElementById("accountBadge");
            if (token.length < 30) {
                badge.style.display = "none";
                return;
            }

            badge.style.display = "block";
            badge.style.color = "var(--primary)";
            badge.innerText = "⏳ در حال شناسایی اکانت...";

            try {
                const res = await fetch("/api/get-account", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ apiToken: token })
                });
                const data = await res.json();
                if (data.success) {
                    detectedAccountId = data.data.accountId;
                    badge.style.color = "var(--success)";
                    cachedWorkers = data.data.workers || [];
                    badge.innerText = "✓ اکانت: " + data.data.accountName + (cachedWorkers.length ? " (" + cachedWorkers.length + " ورکر)" : "");
                    updateWorkerDropdown();
                } else {
                    badge.style.color = "var(--danger)";
                    badge.innerText = "✗ خطا: " + data.message;
                }
            } catch (err) {
                badge.style.color = "var(--danger)";
                badge.innerText = "✗ خطا در ارتباط با کلادفلر";
            }
        }

        async function startDeploy() {
            const apiToken = document.getElementById("apiToken").value.trim();
            const targetType = document.getElementById("targetType").value;
            const workerName = document.getElementById("workerName").value.trim();
            const masterPanelUrl = document.getElementById("masterPanelUrl").value.trim();
            const btn = document.getElementById("deployBtn");
            const status = document.getElementById("statusMsg");
            const resultBox = document.getElementById("resultBox");

            if (!apiToken || !workerName) {
                status.className = "status error";
                status.innerText = "لطفاً توکن و نام ورکر را وارد کنید.";
                return;
            }

            const clusterKey = document.getElementById("clusterKeyInput") ? document.getElementById("clusterKeyInput").value.trim() : "";

            if (!detectedAccountId) {
                await detectAccount();
                if (!detectedAccountId) {
                    status.className = "status error";
                    status.innerText = "شناسایی اکانت ناموفق بود. توکن را بررسی کنید.";
                    return;
                }
            }

            btn.disabled = true;
            btn.innerText = "⏳ در حال استقرار روی کلادفلر...";
            status.className = "status";
            status.innerText = "";
            resultBox.style.display = "none";

            try {
                const res = await fetch("/api/deploy", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ 
                        apiToken, 
                        accountId: detectedAccountId, 
                        targetType, 
                        workerName,
                        masterPanelUrl,
                        clusterKey 
                    })
                });
                const data = await res.json();

                if (data.success) {
                    status.className = "status success";
                    status.innerText = "استقرار با موفقیت انجام شد!";
                    document.getElementById("resUrl").innerText = data.data.url;
                    
                    const keyBox = document.getElementById("keyBox");
                    const resultDesc = document.getElementById("resultDesc");
                    if (data.data.type === "edge") {
                        keyBox.style.display = "block";
                        document.getElementById("resKey").innerText = data.data.apiKey;
                        resultDesc.innerText = "✅ نود فرعی با موفقیت مستقر شد و آمار اکانت آن خودکار به پنل مستر گزارش می‌شود.";
                    } else {
                        keyBox.style.display = "none";
                        resultDesc.innerText = "✅ پنل اصلی مهر با موفقیت آماده شد. با کلیک بر روی لینک بالا وارد پنل شوید.";
                    }
                    resultBox.style.display = "block";
                } else {
                    status.className = "status error";
                    status.innerText = "خطا: " + data.message;
                }
            } catch (err) {
                status.className = "status error";
                status.innerText = "خطا: " + err.message;
            } finally {
                btn.disabled = false;
                btn.innerText = "⚡ شروع استقرار خودکار";
            }
        }

        function copyText(elementId) {
            const text = document.getElementById(elementId).innerText;
            navigator.clipboard.writeText(text).then(() => {
                alert("کپی شد!");
            });
        }
    </script>
</body>
</html>`;
}
