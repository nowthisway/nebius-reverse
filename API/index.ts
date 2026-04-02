export const config = {
  runtime: 'edge',
};

const UPSTREAM_BASE =
  (process.env.NEBIUS_BASE_URL || 'https://api.studio.nebius.ai').replace(/\/+$/, '');

const PROXY_TOKEN = (process.env.PROXY_API_TOKEN || '').trim();

function loadApiKeys(): string[] {
  const keys: string[] = [];
  const envSources = ['NEBIUS_API_KEYS', 'GMI_API_KEYS', 'GMI_KEYS', 'API_KEYS'];

  for (const name of envSources) {
    const raw = (process.env[name] || '').trim().replace(/^["']|["']$/g, '');
    if (!raw) continue;
    keys.push(
      ...raw
        .split(',')
        .map(s => s.trim())
        .filter(isValidApiKey),
    );
    if (keys.length) return [...new Set(keys)];
  }

  for (let i = 1; i <= 20; i++) {
    const key =
      (process.env[`NEBIUS_API_KEY_${i}`] ||
        process.env[`GMI_API_KEY_${i}`] ||
        '').trim();
    if (isValidApiKey(key)) keys.push(key);
  }

  return [...new Set(keys)];
}

function isValidApiKey(key: string): boolean {
  // Nebius key 不是 GMI 的 JWT 三段式，这里只做宽松校验
  return !!key && key.length >= 16;
}

const API_KEYS = loadApiKeys();

function pickApiKey(offset = 0): string {
  if (!API_KEYS.length) throw new Error('No valid API keys configured');
  const i = (Math.floor(Date.now() / 1000) + offset) % API_KEYS.length;
  return API_KEYS[i];
}

function verifyProxyAuth(req: Request): boolean {
  if (!PROXY_TOKEN) return false;
  const auth = req.headers.get('authorization') || '';
  if (!auth.toLowerCase().startsWith('bearer ')) return false;
  const token = auth.slice(7).trim();
  return token === PROXY_TOKEN;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function html(content: string, status = 200) {
  return new Response(content, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function text(content: string, status = 200) {
  return new Response(content, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function readBody(req: Request): Promise<BodyInit | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;

  const contentType = req.headers.get('content-type') || '';

  // JSON 请求可顺手做一次轻量清洗
  if (contentType.includes('application/json')) {
    const raw = await req.text();
    if (!raw) return undefined;

    try {
      const body = JSON.parse(raw);

      // 避免部分上游对 temperature + top_p 同时存在更严格
      if (body.temperature !== undefined && body.top_p !== undefined) {
        delete body.top_p;
      }

      return JSON.stringify(body);
    } catch {
      return raw;
    }
  }

  return await req.arrayBuffer();
}

function buildStatus(req: Request) {
  return {
    service: 'Nebius Proxy on Vercel',
    ok: !!PROXY_TOKEN && API_KEYS.length > 0,
    runtime: 'vercel-edge',
    upstream: UPSTREAM_BASE,
    proxyToken: PROXY_TOKEN ? 'configured' : 'missing',
    apiKeys: API_KEYS.length,
    now: new Date().toISOString(),
    usage: {
      root: `${new URL(req.url).origin}/`,
      status: `${new URL(req.url).origin}/status`,
      example: `${new URL(req.url).origin}/v1/chat/completions`,
    },
  };
}

function statusPage(req: Request) {
  const s = buildStatus(req);
  return html(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Nebius Proxy</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#111}
    .ok{color:#16a34a}.bad{color:#dc2626}
    code,pre{background:#f5f5f5;padding:2px 6px;border-radius:6px}
    .card{border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:16px 0}
  </style>
</head>
<body>
  <h1>Nebius Proxy</h1>
  <p class="${s.ok ? 'ok' : 'bad'}">${s.ok ? '✅ Running' : '❌ Misconfigured'}</p>

  <div class="card">
    <p><b>Upstream:</b> <code>${s.upstream}</code></p>
    <p><b>Proxy Token:</b> ${s.proxyToken}</p>
    <p><b>API Keys:</b> ${s.apiKeys}</p>
  </div>

  <div class="card">
    <p><b>Status:</b> <code>/status</code></p>
    <p><b>Proxy Example:</b></p>
    <pre>POST ${s.usage.example}
Authorization: Bearer YOUR_PROXY_API_TOKEN
Content-Type: application/json</pre>
  </div>
</body>
</html>`);
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (pathname === '/robots.txt') {
    return text('User-agent: *\nDisallow: /');
  }

  if (pathname === '/' && req.method === 'GET' && !req.headers.get('authorization')) {
    return statusPage(req);
  }

  if (pathname === '/status' && req.method === 'GET') {
    return json(buildStatus(req));
  }

  if (!PROXY_TOKEN) {
    return json(
      {
        error: 'Service Unavailable',
        message: 'PROXY_API_TOKEN is not configured',
      },
      503,
    );
  }

  if (!API_KEYS.length) {
    return json(
      {
        error: 'Service Unavailable',
        message: 'No valid Nebius API keys configured',
      },
      503,
    );
  }

  if (!verifyProxyAuth(req)) {
    return json(
      {
        error: 'Unauthorized',
        message: 'Valid Bearer token required',
      },
      401,
    );
  }

  const targetUrl = `${UPSTREAM_BASE}${pathname}${url.search}`;
  const requestBody = await readBody(req);

  let lastRes: Response | null = null;

  for (let attempt = 0; attempt < Math.min(API_KEYS.length, 3); attempt++) {
    const apiKey = pickApiKey(attempt);
    const headers = new Headers(req.headers);

    headers.set('authorization', `Bearer ${apiKey}`);
    headers.set('accept', headers.get('accept') || 'application/json');
    headers.delete('host');
    headers.delete('content-length');
    headers.delete('x-forwarded-for');
    headers.delete('x-forwarded-host');
    headers.delete('x-forwarded-port');
    headers.delete('x-forwarded-proto');
    headers.delete('x-real-ip');
    headers.delete('cf-connecting-ip');
    headers.delete('cf-ipcountry');
    headers.delete('cf-ray');

    try {
      const res = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: requestBody,
        redirect: 'follow',
      });

      if ([401, 403, 429].includes(res.status) && attempt < 2) {
        lastRes = res;
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }

      const outHeaders = new Headers(res.headers);
      outHeaders.set('x-proxy-server', 'vercel-nebius-proxy');
      outHeaders.set('x-proxy-upstream', 'nebius');
      outHeaders.set('x-proxy-retries', String(attempt));

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: outHeaders,
      });
    } catch {
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }

  if (lastRes) {
    const outHeaders = new Headers(lastRes.headers);
    outHeaders.set('x-proxy-server', 'vercel-nebius-proxy');
    outHeaders.set('x-proxy-upstream', 'nebius');
    return new Response(lastRes.body, {
      status: lastRes.status,
      statusText: lastRes.statusText,
      headers: outHeaders,
    });
  }

  return json(
    {
      error: 'Bad Gateway',
      message: 'Upstream request failed after retries',
    },
    502,
  );
}
