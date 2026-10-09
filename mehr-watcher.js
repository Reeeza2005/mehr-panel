export default {
  async fetch(request, env, ctx) {
    const results = await checkNodes(env);
    return new Response(JSON.stringify(results, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkNodes(env));
  }
};

async function checkNodes(env) {
  const nodes = (env.NODE_LIST || "").split(",").map(u => u.trim()).filter(Boolean);
  const report = [];

  for (const url of nodes) {
    try {
      const res = await fetch(url, { 
        headers: { "User-Agent": "Mehr-Watcher" },
        cf: { cacheTtl: 0 }
      });
      const text = await res.text();

      if (!res.ok || text.includes("error code: 1101") || !text.includes("online")) {
        const errorMsg = `⚠️ هشدار قطعی نود مِهر!\n\nنود پاسخ نمی‌دهد یا بن شده است:\n${url}\nکد وضعیت: ${res.status}`;
        await sendAlert(env, errorMsg);
        report.push({ url, status: "down", http_code: res.status });
      } else {
        report.push({ url, status: "healthy", http_code: res.status });
      }
    } catch (err) {
      const alertMsg = `🚨 نود کاملاً از دسترس خارج است:\n${url}\nخطا: ${err.message}`;
      await sendAlert(env, alertMsg);
      report.push({ url, status: "unreachable", error: err.message });
    }
  }

  return report;
}

async function sendAlert(env, msg) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const tgUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(tgUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg })
    });
  } catch (e) {}
}
