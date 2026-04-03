export const config = {
  runtime: 'edge',
};

const UPSTREAM_BASE = 'https://api.studio.nebius.ai';

// 边缘环境全局缓存，加速后续请求
let cachedKeys: string[] =[];
let proxyToken: string | null = null;
let requestCounter = 0;

// 🟢 加载环境变量
function loadConfig() {
  if (cachedKeys.length > 0) return; // 已经加载过就不重复加载

  proxyToken = process.env.PROXY_API_TOKEN?.trim() || null;

  const envSources =['NEBIUS_API_KEYS', 'GMI_API_KEYS', 'API_KEYS'];
  for (const envVar of envSources) {
    const val = process.env[envVar];
    if (val) {
      const keys = val.replace(/^["']|["']$/g, '').split(',').map(k => k.trim()).filter(k => k.length > 15);
      if (keys.length > 0) {
        cachedKeys = keys;
        break;
      }
    }
  }

  // 兜底：循环读取单个配置
  if (cachedKeys.length === 0) {
    for (let i = 1; i <= 20; i++) {
      const k = process.env[`NEBIUS_API_KEY_${i}`];
      if (k && k.trim().length > 15) cachedKeys.push(k.trim());
    }
  }
}

export default async function handler(request: Request) {
  loadConfig();

  // 1️⃣ 精准解析路径 (双重保险，过滤掉 Vercel rewrite 带来的前缀)
  const rawUrl = request.headers.get('x-forwarded-url') || request.url;
  const url = new URL(rawUrl);
  let pathname = url.pathname;
  
  // ⚠️ 终极修复：把内部代理路径剥离，还原如 /v1/chat/completions 的真实路径
  if (pathname.startsWith('/api/proxy')) {
    pathname = pathname.replace('/api/proxy', '') || '/';
  } else if (pathname.startsWith('/api')) {
    pathname = pathname.replace('/api', '') || '/';
  }

  // 2️⃣ CORS 跨域防拦截
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // 3️⃣ 可视化状态监控页 (直接浏览器访问根目录即可看状态)
  if ((pathname === '/' || pathname === '/index.html') && request.method === 'GET' && !request.headers.get('Authorization')) {
    const isOk = proxyToken && cachedKeys.length > 0;
    return new Response(`
      <!DOCTYPE html><html><head><title>Nebius Proxy</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body{font-family:system-ui,sans-serif;background:#111;color:#fff;padding:20px;max-width:600px;margin:0 auto;} .card{background:#222;padding:20px;border-radius:10px;border-left:5px solid ${isOk?'#28a745':'#dc3545'};} code{background:#000;padding:5px;border-radius:5px;}</style></head>
      <body><h1>🚀 Nebius Edge Proxy</h1>
      <div class="card">
        <h2>状态: ${isOk ? '✅ 运行完美' : '❌ 缺失环境变量'}</h2>
        <p>🔑 成功加载的 Keys 数量: <b>${cachedKeys.length}</b></p>
        <p>🛡️ PROXY_API_TOKEN: <b>${proxyToken ? '已配置' : '未配置'}</b></p>
        <hr style="border-color:#444">
        <p>💡 测试端点: <code>/v1/chat/completions</code></p>
      </div></body></html>
    `, { headers: { 'Content-Type': 'text/html; charset=utf-8' }});
  }

  // 4️⃣ 严格鉴权
  if (!proxyToken) return new Response(JSON.stringify({ error: "PROXY_API_TOKEN not set in Vercel" }), { status: 503 });
  if (cachedKeys.length === 0) return new Response(JSON.stringify({ error: "No Nebius API Keys found" }), { status: 503 });

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader.replace('Bearer ', '').trim() !== proxyToken) {
    return new Response(JSON.stringify({ error: "Unauthorized", message: "Invalid Proxy Token" }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  // 5️⃣ 轮询提取 API Key
  const timeSlot = Math.floor(Date.now() / 1000);
  const selectedKey = cachedKeys[(timeSlot + requestCounter++) % cachedKeys.length];

  // 6️⃣ 请求体特殊修复 (解决 vLLM 参数冲突)
  let requestBody = null;
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    try {
      const bodyText = await request.clone().text();
      if (bodyText) {
        try {
          const bodyJson = JSON.parse(bodyText);
          if (bodyJson.temperature !== undefined && bodyJson.top_p !== undefined) {
            delete bodyJson.top_p; // Nebius 模型这两个参数会打架，必须删掉一个
          }
          requestBody = JSON.stringify(bodyJson);
        } catch { requestBody = bodyText; }
      }
    } catch {}
  }

  // 7️⃣ 转发给上游 Nebius
  const targetUrl = `${UPSTREAM_BASE}${pathname}${url.search}`;
  try {
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${selectedKey}`);
    
    // 把 Vercel 特有追踪信息删掉，防止被 Nebius 拦截['Host', 'x-vercel-id', 'x-forwarded-host', 'x-forwarded-for'].forEach(h => headers.delete(h));

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      body: requestBody,
      redirect: "follow"
    });

    const resHeaders = new Headers(response.headers);
    resHeaders.set("Access-Control-Allow-Origin", "*");
    resHeaders.set("X-Proxy-Server", "Vercel-Edge");

    // ✨ 原生流式透传返回，打字机效果不会卡顿！
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: resHeaders
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: "Bad Gateway", message: "Failed to fetch upstream Nebius" }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
}
