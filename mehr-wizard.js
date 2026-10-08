const WIZARD_VERSION = "1.6.1";
// =============================================================================
// Mehr Autonomous Deployment Wizard (Standalone Master & Edge Architecture)
// =============================================================================

const CORE_REPO = "Reeeza2005/mehr-panel";
const CORE_BRANCH = "main";


// -----------------------------------------------------------------------------
// توابع مدیریت دامنه و احراز هویت نودها (v1.6.1)
// -----------------------------------------------------------------------------
async function getOrGenerateApiKey(accountId, token, scriptName) {
    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/bindings`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.success && Array.isArray(data.result)) {
            const found = data.result.find(b => b.name === "API_KEY");
            if (found && (found.text || found.value)) return found.text || found.value;
        }
    } catch (e) {}

    // کلید ثابت و یکتا بر اساس هش AccountId و ScriptName (همیشه ثابت، بدون دیتابیس)
    const msgBuffer = new TextEncoder().encode(accountId + ":" + scriptName + ":mehr_secret_salt");
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("").substring(0, 32);
    return "mehr_sec_" + hashHex;
}

async function getWorkerUrl(accountId, token, scriptName, isMasterPanel = false) {
    let subdomain = "";
    try {
        const subRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const subData = await subRes.json();
        subdomain = subData?.result?.subdomain || "";
    } catch (e) {}

    if (!subdomain) {
        const candidate = "mehr-" + Math.random().toString(36).substring(2, 8);
        try {
            const createRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
                method: "PUT",
                headers: { 
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ subdomain: candidate })
            });
            const createData = await createRes.json();
            if (createData.success && createData.result?.subdomain) {
                subdomain = createData.result.subdomain;
            }
        } catch (e) {}
    }

    // فعال‌سازی روت ساب‌دامین برای ورکر
    try {
        await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, {
            method: "POST",
            headers: { 
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ enabled: true })
        });
    } catch (e) {}

    const finalSub = subdomain || "workers";
    const base = `https://${scriptName}.${finalSub}.workers.dev`;
    return isMasterPanel ? `${base}/sync/dash` : base;
}

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
        const { apiToken, accountId, targetType, workerName } = await request.json();
        if (!apiToken || !accountId || !workerName || !targetType) {
            return jsonRes(false, "تمامی فیلدها الزامی هستند.");
        }

        const cleanName = workerName.toLowerCase().trim().replace(/[^a-z0-9-_]/g, "");

        if (targetType === "master") {
            return await deployMasterPanel(apiToken, accountId, cleanName);
        } else if (targetType === "edge") {
            return await deployEdgeNode(apiToken, accountId, cleanName);
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
                    'apiRoute', 'sync'
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
// ۲. استقرار نود لبه کاملاً مستقل (Autonomous Edge Node)
// -----------------------------------------------------------------------------
async function deployEdgeNode(token, accountId, nodeName) {
    const nodeApiKey = await getOrGenerateApiKey(accountId, token, nodeName);
    const agentSource = await fetchFromGithub("mehr-agent.js");
    const agentVerMatch = agentSource.match(/const AGENT_VERSION = ["']([^"']+)["']/);
    const deployedAgentVersion = agentVerMatch ? agentVerMatch[1] : WIZARD_VERSION;

    // متغیرهای کاملاً مستقل: فقط شناسه، کلید کنترل و مشخصات برای آمارگیری کلادفلر
    const edgeBindings = [
        { type: "plain_text", name: "NODE_ID", text: nodeName },
        { type: "plain_text", name: "API_KEY", text: nodeApiKey },
        { type: "plain_text", name: "CF_ACCOUNT_ID", text: accountId },
        { type: "plain_text", name: "CF_API_TOKEN", text: token }
    ];

    const form = new FormData();
    const metadata = {
        main_module: "worker.js",
        compatibility_date: "2024-09-23",
        compatibility_flags: ["nodejs_compat"],
        bindings: edgeBindings
    };

    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("worker.js", new Blob([agentSource], { type: "application/javascript+module" }), "worker.js");

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

    return jsonRes(true, "نود فرعی با موفقیت مستقر شد.", {
        type: "edge",
        url: finalUrl,
        apiKey: nodeApiKey,
        name: nodeName,
        version: deployedAgentVersion
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
    const rawUrl = `https://raw.githubusercontent.com/${CORE_REPO}/${CORE_BRANCH}/${filePath}?_nocache=${Date.now()}_${Math.random()}`;
    const res = await fetch(rawUrl, {
        headers: {
            "User-Agent": "Mehr-Wizard-Installer",
            "Accept": "text/plain",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
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
        <h1>ویزارد جامع راه‌اندازی کلاستر مِهر <span style="font-size: 13px; background: #2563eb; color: #fff; padding: 2px 8px; border-radius: 9999px; margin-right: 8px; vertical-align: middle;">v${version}</span></h1>
        <p>استقرار مستقل پنل اصلی یا نودهای لبه بدون پیچیدگی و وابستگی.</p>

        <div class="token-helper">
            <span>ساخت سریع توکن با دسترسی‌های کامل:</span>
            <a href="https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[{%22key%22:%22workers_scripts%22,%22type%22:%22edit%22},{%22key%22:%22workers_kv_storage%22,%22type%22:%22edit%22},{%22key%22:%22d1%22,%22type%22:%22edit%22},{%22key%22:%22account_settings%22,%22type%22:%22read%22},{%22key%22:%22analytics%22,%22type%22:%22read%22},{%22key%22:%22dns%22,%22type%22:%22edit%22},{%22key%22:%22workers_routes%22,%22type%22:%22edit%22},{%22key%22:%22zone%22,%22type%22:%22read%22}]&name=Mehr+Hub+Token" target="_blank" class="btn-link">🔑 ایجاد توکن خودکار</a>
        </div>

        <div class="field">
            <label>Cloudflare API Token</label>
            <input type="password" id="apiToken" placeholder="توکن اکانت مقصد را وارد کنید" oninput="detectAccount()">
            <div class="account-badge" id="accountBadge"></div>
        </div>

        <div class="field">
            <label>عملیات مورد نظر</label>
            <select id="targetType" onchange="updateTargetUI(); updateWorkerDropdown();">
                <option value="master">🚀 نصب / به‌‌روزرسانی پنل اصلی (Master Panel)</option>
                <option value="edge">👻 راه‌اندازی نود فرعی جدید (Independent Edge Node)</option>
            </select>
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
            <div class="result-item" style="border-bottom: 1px dashed var(--border, #334155); padding-bottom: 10px; margin-bottom: 10px;">
                <div class="result-label">🏷️ نسخه مستقر شده:</div>
                <div class="result-val"><b id="resVersion" style="color:var(--success, #10b981);">v1.6.1</b></div>
            </div>
            <div class="result-item">
                <div class="result-label">🌐 آدرس نود / پنل مستقر شده:</div>
                <div class="result-val">
                    <span id="resUrl"></span>
                    <button class="copy-btn" onclick="copyText('resUrl')">کپی</button>
                </div>
            </div>
            <div class="result-item" id="keyBox">
                <div class="result-label">🔑 کلید کنترل نود (API Key جهت ثبت در پنل مستر):</div>
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

            if (type === "master") {
                label.innerText = "نام ورکر پنل اصلی";
                nameInput.value = "mehr";
            } else {
                label.innerText = "نام ورکر نود فرعی";
                nameInput.value = "node-edge-3";
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
            const btn = document.getElementById("deployBtn");
            const status = document.getElementById("statusMsg");
            const resultBox = document.getElementById("resultBox");

            if (!apiToken || !workerName) {
                status.className = "status error";
                status.innerText = "لطفاً توکن و نام ورکر را وارد کنید.";
                return;
            }

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
                        workerName
                    })
                });
                const data = await res.json();

                if (data.success) {
                    status.className = "status success";
                    status.innerText = "استقرار با موفقیت انجام شد!";
                    document.getElementById("resUrl").innerText = data.data.url;
                    if (document.getElementById("resVersion")) document.getElementById("resVersion").innerText = "v" + (data.data.version || "1.6.1");
                    
                    const keyBox = document.getElementById("keyBox");
                    const resultDesc = document.getElementById("resultDesc");
                    if (data.data.type === "edge") {
                        keyBox.style.display = "block";
                        document.getElementById("resKey").innerText = data.data.apiKey;
                        resultDesc.innerText = "✅ نود فرعی با موفقیت مستقر شد. آدرس و کلید بالا را در پنل مستر وارد کنید تا کنترل کامل آن برقرار شود.";
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









