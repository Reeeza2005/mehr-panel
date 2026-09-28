# نقشه ساختاری و نمایه سورس‌کد (_worker.js)
- **تعداد کل خطوط:** 1212
- **تاریخ تولید:** ۲۰۲۶

## ۱. ساختار کلان و بلوک‌های اصلی

| ردیف | خط | عنوان بخش / ماژول | نمونه کد |
| :--- | :--- | :--- | :--- |
| 1 | خط 1 | انکودینگ سابسکریپشن | `function safeB64(str) {` |
| 2 | خط 55 | فرمت‌دهی نام کانفیگ‌ها | `function formatConfigName(proto, userName, port, h` |
| 3 | خط 209 | روت داشبورد وب | `import HTML_CONTENT from "./dashboard.html";` |
| 4 | خط 250 | لودینگ تنظیمات (loadConfig) | `async function loadConfig(env) {` |
| 5 | خط 272 | هندلر صادراتی ورکر (Worker Entrypoint) | `export default {` |
| 6 | خط 273 | مسیریاب اصلی ترافیک (fetch Router) | `async fetch(request, env, ctx) {` |
| 7 | خط 313 | روت تحویل سابسکریپشن | `if (reqPath.includes('/sub/') \|\| subParam) {` |
| 8 | خط 546 | فرمت‌دهی نام کانفیگ‌ها | `vlessConfigs.push("vless://" + userUuid + "@" + ep` |
| 9 | خط 549 | فرمت‌دهی نام کانفیگ‌ها | `vlessConfigs.push("trojan://" + userUuid + "@" + e` |
| 10 | خط 709 | انکودینگ سابسکریپشن | `const payload = safeB64(vlessConfigs.join("\n") + ` |
| 11 | خط 717 | روت داشبورد وب | `if (reqPath === `${routeBase}/dash` \|\| reqPath =` |
| 12 | خط 727 | اندپوینت احراز هویت | `if (reqPath === `${routeBase}/api/auth` \|\| reqPa` |
| 13 | خط 813 | اندپوینت ذخیره و به‌روزرسانی | `if (reqPath === `${routeBase}/api/update` \|\| req` |
| 14 | خط 1205 | انکودینگ سابسکریپشن | `return new Response(safeB64(vlessUrl), {` |

## ۲. فهرست توابع تعریف‌شده در فایل

- **خط 1:** `function safeB64(str)`
- **خط 10:** `function getCountryFlag(cc)`
- **خط 16:** `function toJalaliDate(d)`
- **خط 37:** `function gregorianToJalali(gy, gm, gd)`
- **خط 55:** `function formatConfigName(proto, userName, port, hostName, ip, configIndex, sysConf, countryCode, isUpstream = false)`
- **خط 79:** `function generateInfoConfigs(sysConf, userRec, usedBytes, host)`
- **خط 155:** `function getLiveUsageMap(env, sysConfig)`
- **خط 190:** `function getPureHost(s)`
- **خط 195:** `function getAllProfiles(targetSub = null)`
- **خط 234:** `function d1Get(env, key)`
- **خط 243:** `function d1Put(env, key, value)`
- **خط 250:** `function loadConfig(env)`
- **خط 260:** `function jsonResponse(data, status = 200)`
