# نمایه معماری و مستند جامع هسته ورکر (_worker.js)
- **حجم فایل:** 1,212 خط
- **وضعیت:** تحلیل و دسته‌بندی ماشینی خط‌به‌خط

---

## فهرست دسته‌بندی ماژول‌ها و توابع هسته

### ۱. مسیریابی و اندپوینت‌ها (Routes & Endpoints) (0 مورد)
_موردی در این دسته‌بندی به‌صورت مستقیم تعریف نشده است._

### ۲. ماژول‌های سابسکریپشن و تولید کانفیگ (Sub & Configs) (3 مورد)
| شماره خط | تابع / هدف | جزئیات / نمونه کد |
| :--- | :--- | :--- |
| خط 55 | `formatConfigName(proto, userName, port, hostName, ip, configIndex, sysConf, countryCode, isUpstream = false)` | - |
| خط 79 | `generateInfoConfigs(sysConf, userRec, usedBytes, host)` | - |
| خط 250 | `loadConfig(env)` | - |

### ۳. پایگاه داده و تعامل با D1/KV (Database Operations) (3 مورد)
| شماره خط | تابع / هدف | جزئیات / نمونه کد |
| :--- | :--- | :--- |
| خط 155 | `getLiveUsageMap(env, sysConfig)` | - |
| خط 234 | `d1Get(env, key)` | - |
| خط 243 | `d1Put(env, key, value)` | - |

### ۴. هسته ترافیک و هندلر سوکت (WebSocket & Traffic Relay) (0 مورد)
_موردی در این دسته‌بندی به‌صورت مستقیم تعریف نشده است._

### ۵. احراز هویت و امنیت (Auth & Cryptography) (0 مورد)
_موردی در این دسته‌بندی به‌صورت مستقیم تعریف نشده است._

### ۶. رابط کاربری و رندرینگ وب (UI & Template Handlers) (0 مورد)
_موردی در این دسته‌بندی به‌صورت مستقیم تعریف نشده است._

### ۷. توابع کمکی و ابزارها (Helpers & Utils) (7 مورد)
| شماره خط | تابع / هدف | جزئیات / نمونه کد |
| :--- | :--- | :--- |
| خط 1 | `safeB64(str)` | - |
| خط 10 | `getCountryFlag(cc)` | - |
| خط 16 | `toJalaliDate(d)` | - |
| خط 37 | `gregorianToJalali(gy, gm, gd)` | - |
| خط 190 | `getPureHost(s)` | - |
| خط 195 | `getAllProfiles(targetSub = null)` | - |
| خط 260 | `jsonResponse(data, status = 200)` | - |
