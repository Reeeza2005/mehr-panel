
## [3.5.1] - 2026-09-28
### Added & Fixed (Localization / i18n)
- **Smart Router (T7-M):** Full bilingual support (FA/EN) for modal rules, social block toggles, security filters, and bypass settings.
- **Servers Tab (T4):**
  - Standardized sidebar button label and typography (`Servers` / `سرورها`) aligned with Nahan i18n engine.
  - Localized cluster network badge and action buttons (Refresh, Add Node).
  - Localized master worker telemetry cards (Active Users, Today Usage, Total Usage, Cluster Role, Database/D1 status).
  - Localized slave worker cards (latency, ping test, delete action, online/offline status).
- **Maintenance:** Cleaned up temporary patch and inspection scripts to ensure workspace stability.


## [3.5.1] - 2026-09-28
### Added & Fixed (Localization / i18n)
- **Smart Router (T7-M):** Full bilingual support (FA/EN) for user modal filters, social blocks, malware/ad blocks, and bypass rules.
- **Servers Tab (T4):** 
  - Standardized sidebar button label and typography (`Servers` / `سرورها`) aligned with Nahan i18n engine.
  - Localized cluster capacity badge and action buttons (Refresh Status, Add Node).
  - Localized master worker card metrics (Active Users, Today Usage, Total Usage, Cluster Role, Database/D1 status).
  - Localized slave worker cards (latency, ping action, delete action, online/offline status).
- **Cleanup:** Purged temporary shell patch scripts to maintain repository stability.

# CHANGELOG — پروژه مهر (Mehr)

> این فایل تغییرات واقعی و قابل‌ردیابی پروژه را ثبت می‌کند.
> فقط تغییراتی که واقعاً انجام شده‌اند باید در این فایل ثبت شوند.

---

## 2026-09-23

### سیستم حافظه و مستندسازی پروژه

- ایجاد `docs/ai/AI_RULES.md`
- ایجاد `docs/ai/PROJECT.md`
- ایجاد `docs/ai/TODO.md`
- ایجاد `docs/ai/DECISIONS.md`
- تعریف ساختار اولیه مستندسازی پروژه
- تبدیل مستندسازی از مدل وابسته به تعداد چت‌ها به مدل رویدادمحور
- تعریف منابع اصلی حقیقت پروژه برای شروع چت‌های جدید
- مشخص کردن اینکه حافظه چت به تنهایی منبع قابل اتکای پروژه نیست

### معماری مستندشده

- ثبت معماری Mehr بر پایه UI اصلاح‌شده Nahan و BPB Core
- ثبت اینکه Mehr خودش VPN یا Core مستقل ندارد
- ثبت نقش Wizard در راه‌اندازی Panel و Secondary Worker
- ثبت برنامه اضافه کردن Smart Router به پنل Mehr

---

## قوانین این فایل

- فقط تغییرات واقعی ثبت شوند.
- تغییرات مهم در همان زمان وقوع ثبت شوند.
- تغییرات جزئی و بی‌اهمیت لازم نیست ثبت شوند.
- تاریخ هر تغییر مشخص باشد.
- اگر یک تغییر بزرگ چند مرحله دارد، مراحل مهم آن جداگانه ثبت شوند.
- از ثبت تغییراتی که فقط پیشنهاد شده‌اند یا هنوز انجام نشده‌اند خودداری شود.

#### 2026-09-29
##### تثبیت تب سرورها و پایش سلامت نودها
* اصلاح و پایداری تابع pingHost با ساختار بازگشتی استاندارد (ok, latency).
* اتصال رویداد کلیک دکمه «🔄 به‌روزرسانی وضعیت» به چرخه ارزیابی زنده autoCheckNodesHealth.
* رفع نمایش نام نودها بر اساس هاست ورکر و تنظیم پرچم کلاستر در کادر هر نود.

#### 2026-09-29
##### پیاده‌سازی و اعتبارسنجی تلمتری ترافیک کاربران در نود لبه (mehr-agent.js)
* تعریف نگاشت حافظه pendingUserTraffic برای ثبت بایت‌های مصرفی کاربران به تفکیک UUID.
* اندازه‌گیری بلادرنگ بایت‌های ارسالی (Uplink) و دریافتی (Downlink) در پایپ‌های WebSocket پروتکل VLESS.
* الحاق آرایه user_traffic به بسته ارسالی در متد syncWithMaster و کسر بایت‌های بافرشده پس از پاسخ موفق مستر.
* اعتبارسنجی سینتکس فایل mehr-agent.js با موتور Node.js (Syntax Verified).
