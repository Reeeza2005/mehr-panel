# معماری سیستم کلاستر پنل مِهر (Mehr Cluster System)

## ۱. متغیرهای الزامی نود لبه (Edge Node Secrets)
- PANEL_URL: آدرس کامل ورکر پنل اصلی (مثال: https://mehr.v5twycq1o.workers.dev)
- CLUSTER_KEY: کلید رمزنگاری مشترک برای تایید اعتبار پکت‌های ارسالی
- NODE_ID: شناسه یکتای نود که باید با شناسه موجود در دیتابیس مطابقت داشته باشد (مثال: node1)
- CF_ACCOUNT_ID: شناسه اکانت کلادفلر میزبانی‌کننده نود لبه
- CF_API_TOKEN: توکن اختصاصی کلادفلر با دسترسی Analytics:Read برای استعلام درخواست‌ها از GraphQL

## ۲. ساختار پکت ارسالی در مسیر /api/node/sync
```json
{
  "node_id": "node1",
  "timestamp": 1727980000,
  "daily_requests": 1420,
  "requests": 1420,
  "country": "US",
  "user_traffic": [
    { "uuid": "user-uuid-1", "up": 1048576, "down": 5242880 }
  ]
}
```

## ۳. نگاشت در پایگاه داده مستر (D1 Database)
- جدول nodes:
  - id: شناسه یکتا (node_id)
  - daily_requests: درخواست‌های روزانه رسمی اکانت کلادفلر
  - last_seen: زمان یونیکس آخرین ارتباط
- جدول node_traffic:
  - کلید ترکیبی: (user_uuid, node_id)
  - مصرف کاربر به ازای نود در ستون‌های bytes_uploaded و bytes_downloaded تجمیع می‌شود.

## ۴. رندر در داشبورد (dashboard.html)
- آمار کلادفلر هر نود کاملاً مستقل است و به آمار مستر فال‌بک نمی‌کند.
- مصرف امروز و کل نود حاصل تجمیع بایت‌های همان نود از جدول node_traffic است.
