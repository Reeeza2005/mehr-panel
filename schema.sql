CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    uuid TEXT,
    username TEXT,
    name TEXT,
    traffic_limit INTEGER DEFAULT 0,
    used_traffic INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    expiry_date TEXT,
    created_at TEXT
);

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
    last_seen TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS clean_ips (
    id TEXT PRIMARY KEY,
    ip TEXT,
    operator TEXT DEFAULT 'ALL',
    status TEXT DEFAULT 'active'
);
