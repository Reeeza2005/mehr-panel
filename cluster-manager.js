/**
 * Cluster & Node Management Module for Mehr Panel
 * Pure Modular JS - Mounts into #tab-nodes-grid safely
 */

(function () {
    function getCountryFlagEmoji(code) {
        if (!code || typeof code !== "string" || code.length !== 2) return "";
        const cc = code.toUpperCase();
        if (cc === "XX" || cc === "T1") return "🌐";
        return String.fromCodePoint(...[...cc].map(c => 127397 + c.charCodeAt(0)));
    }

    function cleanHost(s) {
        return (s || "").replace(/^[a-zA-Z]+:\/\//, "").split("/")[0].split("@").pop().split(":")[0].trim();
    }

    function formatGB(b) {
        return b > 0 ? (b / (1024 * 1024 * 1024)).toFixed(2) + " GB" : "0.00 GB";
    }

    window.updateNodeProp = function (idx, prop, val) {
        const cfg = (typeof getActivePanelConfig === "function") ? getActivePanelConfig() : (window.nahanConfig || {});
        if (cfg.linkedPanels && cfg.linkedPanels[idx]) {
            cfg.linkedPanels[idx][prop] = val;
            if (typeof showToast === "function") {
                showToast("تنظیمات نود موقتاً اعمال شد. دکمه ذخیره تنظیمات را بزنید.", "info");
            }
        }
    };

    window.toggleNodeUpstream = function (idx, enabled) {
        const cfg = (typeof getActivePanelConfig === "function") ? getActivePanelConfig() : (window.nahanConfig || {});
        if (cfg.linkedPanels && cfg.linkedPanels[idx]) {
            cfg.linkedPanels[idx].useUpstream = !!enabled;
            if (typeof showToast === "function") {
                showToast(enabled ? "هدایت نود به Upstream فعال شد." : "هدایت نود به Upstream غیرفعال شد.", "info");
            }
        }
    };

    window.renderTabNodes = function () {
        const grid = document.getElementById("tab-nodes-grid");
        const badge = document.getElementById("tab-cluster-capacity-badge");
        if (!grid) return;

        const cfg = (typeof getActivePanelConfig === "function") ? getActivePanelConfig() : (window.nahanConfig || {});
        const panels = Array.isArray(cfg.linkedPanels) ? cfg.linkedPanels : [];
        const users = Array.isArray(cfg.users) ? cfg.users : [];
        const stats = window.clusterNodeStats?.nodes || {};
        const totalNodes = panels.length;

        if (badge) {
            badge.innerText = `شبکه فعال ورکرها: ${totalNodes} ورکر فرعی | ظرفیت پروکسی: ${(totalNodes * 100).toLocaleString("fa-IR")} هزار درخواست روزانه`;
        }

        let masterUsersCount = 0, masterTotalBytes = 0, masterTodayBytes = 0;
        users.forEach(u => {
            const un = String(u.userNodes || "").toLowerCase();
            const isAssigned = !un || un === "all" || un.includes(window.location.hostname.toLowerCase());
            if (isAssigned) {
                masterUsersCount++;
                masterTotalBytes += Number(u.traffic_used || u.used_traffic || u.total_traffic || u.usedTraffic || 0);
                masterTodayBytes += Number(u.today_traffic || u.todayTraffic || 0);
            }
        });

        // کارت ورکر اصلی
        let html = `
            <div class="bg-[var(--color-surface)] rounded-2xl border-2 border-primary/30 dark:border-primary/20 p-5 shadow-sm space-y-4 relative overflow-hidden">
                <div class="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-darkborder/60">
                    <div class="flex items-center gap-2">
                        <span class="w-3 h-3 rounded-full bg-emerald-500 animate-pulse"></span>
                        <h3 class="text-sm font-black text-slate-800 dark:text-white">ورکر اصلی (کنترل پنل و دیتابیس)</h3>
                    </div>
                    <span class="px-2.5 py-1 text-xs font-bold rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">آنلاین</span>
                </div>
                <div class="text-xs font-mono text-slate-800 dark:text-slate-100 bg-slate-50 dark:bg-darkcard/80 p-2.5 rounded-xl border border-slate-200 dark:border-darkborder text-center">
                    ${window.location.hostname}
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 text-center">
                    <div class="bg-slate-100/80 dark:bg-slate-800/90 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700">
                        <span class="text-slate-500 dark:text-slate-400 block text-[11px] mb-1">نقش در کلاستر</span>
                        <span class="font-bold text-xs text-primary">Control Plane (مدیریت)</span>
                    </div>
                    <div class="bg-slate-100/80 dark:bg-slate-800/90 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700">
                        <span class="text-slate-500 dark:text-slate-400 block text-[11px] mb-1">ترافیک عبوری</span>
                        <span class="font-bold text-xs text-slate-600 dark:text-slate-300">غیرفعال (امنیت پنل)</span>
                    </div>
                    <div class="bg-slate-100/80 dark:bg-slate-800/90 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700">
                        <span class="text-slate-500 dark:text-slate-400 block text-[11px] mb-1">بانک اطلاعاتی / D1</span>
                        <span class="font-bold text-xs text-emerald-600 dark:text-emerald-400">متصل و فعال</span>
                    </div>
                </div>
                <div class="pt-1 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span>میزبان کنترل پنل مرکزی</span>
                    <span class="text-emerald-500 dark:text-emerald-400 font-semibold">پایدار</span>
                </div>
            </div>
        `;

        // کارت نودهای فرعی
        panels.forEach((p, idx) => {
            const rawUrl = (typeof p === "object" ? p.url : p) || "";
            const host = cleanHost(rawUrl);
            const lowHost = host.toLowerCase();
            const apiKey = (typeof p === "object" ? p.apiKey : "") || "";
            const st = stats[host] || stats[lowHost] || stats[rawUrl] || {};
            const isOnline = st.online === true;
            const latency = st.latency ? (st.latency + " ms") : "--";
            const country = st.country || stats[lowHost]?.country || "";
            const flagEmoji = getCountryFlagEmoji(country);
            const dailyReqs = st.daily_requests ?? stats[lowHost]?.daily_requests ?? 0;

            let nodeUsers = 0, nodeTotalBytes = 0, nodeTodayBytes = 0;
            users.forEach(u => {
                const un = String(u.userNodes || "").toLowerCase();
                if (un.includes(lowHost) || un === "all" || !un) {
                    nodeUsers++;
                    nodeTotalBytes += Number(u.traffic_used || u.used_traffic || u.total_traffic || u.usedTraffic || 0);
                    nodeTodayBytes += Number(u.today_traffic || u.todayTraffic || 0);
                }
            });

            html += `
                <div class="bg-[var(--color-surface)] rounded-2xl border border-slate-200 dark:border-darkborder p-5 shadow-sm space-y-4 flex flex-col justify-between">
                    <div class="space-y-3">
                        <div class="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-darkborder/60">
                            <div class="flex items-center gap-2">
                                <span class="w-2.5 h-2.5 rounded-full ${isOnline ? "bg-emerald-500" : "bg-rose-500"}"></span>
                                <h3 class="text-sm font-bold text-slate-800 dark:text-white flex items-center gap-1.5">
                                    <span>نود فرعی ${idx + 1}</span>
                                    ${flagEmoji ? `<span class="text-base" title="${country}">${flagEmoji}</span>` : ""}
                                    ${country ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-darkborder text-slate-700 dark:text-slate-200 font-mono font-bold">${country}</span>` : ""}
                                </h3>
                            </div>
                            <span class="px-2.5 py-1 text-xs font-bold rounded-lg ${isOnline ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/10 text-rose-500"}">
                                ${isOnline ? "آنلاین" : "غیرفعال / آفلاین"}
                            </span>
                        </div>

                        <div class="text-xs font-mono text-slate-800 dark:text-slate-100 break-all bg-slate-50 dark:bg-darkcard/80 p-2.5 rounded-xl border border-slate-200 dark:border-darkborder flex items-center justify-between">
                            <span>${host}</span>
                            ${apiKey ? `<span class="text-[10px] text-slate-400 font-mono" title="API Key: ${apiKey}">🔑 ${apiKey.substring(0, 8)}...</span>` : ""}
                        </div>

                        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                            <div class="bg-slate-50 dark:bg-darkcard/80 p-2.5 rounded-xl border border-slate-200 dark:border-darkborder">
                                <span class="text-slate-500 dark:text-slate-400 block text-[11px] mb-1">کاربران مجاز</span>
                                <span class="font-bold text-xs text-slate-800 dark:text-white">${nodeUsers}</span>
                            </div>
                            <div class="bg-slate-50 dark:bg-darkcard/80 p-2.5 rounded-xl border border-slate-200 dark:border-darkborder">
                                <span class="text-slate-500 dark:text-slate-400 block text-[11px] mb-1">مصرف امروز</span>
                                <span class="font-bold text-xs text-slate-800 dark:text-white">${formatGB(nodeTodayBytes)}</span>
                            </div>
                            <div class="bg-slate-50 dark:bg-darkcard/80 p-2.5 rounded-xl border border-slate-200 dark:border-darkborder">
                                <span class="text-slate-500 dark:text-slate-400 block text-[11px] mb-1">مصرف کل</span>
                                <span class="font-bold text-xs text-primary font-mono">${formatGB(nodeTotalBytes)}</span>
                            </div>
                            <div class="bg-slate-50 dark:bg-darkcard/80 p-2.5 rounded-xl border border-slate-200 dark:border-darkborder">
                                <span class="text-slate-500 dark:text-slate-400 block text-[11px] mb-1">درخواست امروز</span>
                                <span class="font-bold text-xs font-mono text-slate-800 dark:text-white">${Number(dailyReqs).toLocaleString("fa-IR")}</span>
                            </div>
                        </div>

                        <div class="flex items-center justify-between text-xs px-1 text-slate-600 dark:text-slate-300">
                            <span>تاخیر پینگ:</span>
                            <span class="font-mono font-bold ${isOnline ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400"}">${latency}</span>
                        </div>

                        <div class="mt-2 pt-2 border-t border-slate-100 dark:border-darkborder/60 space-y-2 text-xs">
                            <div class="flex items-center justify-between gap-2">
                                <span class="text-slate-400 text-[11px] whitespace-nowrap">پروکسی IP:</span>
                                <input type="text" value="${p.proxyIp || ""}" placeholder="104.18.2.1"
                                    onchange="updateNodeProp(${idx}, 'proxyIp', this.value.trim())"
                                    class="w-40 px-2 py-1 text-[11px] font-mono rounded-lg bg-slate-50 dark:bg-darkcard border border-slate-200 dark:border-darkborder text-slate-800 dark:text-white focus:outline-none focus:border-primary text-center">
                            </div>
                            <label class="flex items-center justify-between cursor-pointer text-slate-700 dark:text-slate-200">
                                <span class="text-[11px] font-medium">هدایت به Upstream (🔗)</span>
                                <input type="checkbox" ${p.useUpstream ? "checked" : ""}
                                    onchange="toggleNodeUpstream(${idx}, this.checked)"
                                    class="w-4 h-4 text-primary rounded border-slate-300 dark:border-darkborder cursor-pointer">
                            </label>
                        </div>
                    </div>

                    <div class="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-darkborder/60 gap-2">
                        <button id="btn-ping-${idx}" onclick="testSingleNode('${host}', 'btn-ping-${idx}')" class="flex-1 py-2 px-3 text-xs font-bold rounded-xl bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 dark:bg-primary/20 dark:text-primary transition flex items-center justify-center gap-1.5 shadow-sm">
                            <span>تست پینگ</span>
                        </button>
                        <button onclick="removeLinkedNode(${idx})" class="py-2 px-3 text-xs font-bold rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 border border-rose-500/20 transition flex items-center justify-center gap-1 shadow-sm">
                            <span>حذف</span>
                        </button>
                    </div>
                </div>
            `;
        });

        grid.innerHTML = html;
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", window.renderTabNodes);
    } else {
        setTimeout(window.renderTabNodes, 300);
    }
})();
