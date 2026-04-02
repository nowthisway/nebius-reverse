export const config = {
  runtime: 'edge',
};

// ✅ API Key 管理类
class APIKeyManager {
  private apiKeys: string[] =[];
  private requestCounter = 0;
  private loadError: string | null = null;

  constructor() {
    this.loadKeysFromEnv();
  }

  private loadKeysFromEnv(): void {
    const envSources =['NEBIUS_API_KEYS', 'GMI_API_KEYS', 'API_KEYS'];

    for (const envVar of envSources) {
      const keysStr = process.env[envVar];
      if (keysStr) {
        const cleanKeysStr = keysStr.replace(/^["']|["']$/g, '');
        const keyArray = cleanKeysStr.split(',').map(k => k.trim()).filter(k => k.length > 0);
          
        for (const key of keyArray) {
          if (key.length > 15) this.apiKeys.push(key);
        }
        if (this.apiKeys.length > 0) break;
      }
    }

    if (this.apiKeys.length === 0) {
      for (let i = 1; i <= 20; i++) {
        const key = process.env[`NEBIUS_API_KEY_${i}`];
        if (key && key.trim().length > 15) this.apiKeys.push(key.trim());
      }
    }

    if (this.apiKeys.length === 0) {
      this.loadError = 'No valid API keys found! Please set NEBIUS_API_KEYS.';
    }
  }

  hasValidKeys(): boolean { return this.apiKeys.length > 0; }

  getNextAPIKey(): string {
    if (!this.hasValidKeys()) throw new Error('No keys');
    const timeSlot = Math.floor(Date.now() / 1000);
    const index = (timeSlot + this.requestCounter) % this.apiKeys.length;
    this.requestCounter++;
    return this.apiKeys[index];
  }

  getPublicKeyStatus() {
    return {
      total: this.apiKeys.length,
      usage: new Array(this.apiKeys.length).fill(0),
      hasKeys: this.apiKeys.length > 0,
      ...(this.loadError && this.apiKeys.length === 0 ? { error: this.loadError } : {})
    };
  }
}

// ✅ 代理访问认证管理器
class ProxyAuthManager {
  private customToken: string | null = null;
  constructor() {
    const token = process.env.PROXY_API_TOKEN;
    if (token && token.trim().length > 0) this.customToken = token.trim();
  }
  validateToken(token: string): boolean { return !!this.customToken && this.customToken === token; }
  hasValidToken(): boolean { return this.customToken !== null; }
}

const stats = { totalRequests: 0, successfulRequests: 0, failedRequests: 0, startTime: Date.now() };

let keyManager: APIKeyManager | null = null;
let authManager: ProxyAuthManager | null = null;

const UPSTREAM_BASE = 'https://api.tokenfactory.eu-west1.nebius.com';

export default async function handler(request: Request): Promise<Response> {
  if (!keyManager) keyManager = new APIKeyManager();
  if (!authManager) authManager = new ProxyAuthManager();

  // ⚠️ 关键修复：Vercel Edge 可能会在 request.url 混淆路径，优先取 x-forwarded-url 头，确保代理路径百分百精准！
  const rawUrl = request.headers.get('x-middleware-request-url') || request.headers.get('x-forwarded-url') || request.url;
  const url = new URL(rawUrl);
  
  // 处理 Vercel 路由 rewrite 的路径问题，确保获取真实的请求路径
  let pathname = url.pathname;
  if (pathname.startsWith('/api') && pathname !== '/api') {
      pathname = pathname.replace('/api', '');
  }
  if (pathname === '') pathname = '/';
  
  const search = url.search;
  stats.totalRequests++;

  // ✅ OPTIONS 预检请求 (CORS 跨域防拦截)
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

  // ✅ 首页状态页 (没带 Bearer token 的 GET 请求直接显示状态)
  if ((pathname === '/' || pathname === '/index.html' || pathname === '/api') && request.method === 'GET' && !request.headers.get('Authorization')) {
    return htmlResponse(generateStatusPage(request.url));
  }

  // ✅ 前置拦截校验
  if (!authManager.hasValidToken()) return jsonResponse({ error: "Proxy token not configured" }, 503);
  if (!keyManager.hasValidKeys()) return jsonResponse({ error: "No valid Nebius keys" }, 503);
  
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authManager.validateToken(authHeader.replace('Bearer ', '').trim())) {
    return jsonResponse({ error: "Unauthorized", message: "Invalid Proxy Token" }, 401);
  }

  // ✅ 构造要转发的上游 URL
  const targetUrl = `${UPSTREAM_BASE}${pathname}${search}`;
  let apiKey: string;
  try { apiKey = keyManager.getNextAPIKey(); } catch { return jsonResponse({ error: "No Keys" }, 503); }

  let requestBody = null;
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    try {
      const bodyText = await request.clone().text();
      try {
        const bodyJson = JSON.parse(bodyText);
        if (bodyJson.temperature !== undefined && bodyJson.top_p !== undefined) delete bodyJson.top_p;
        requestBody = JSON.stringify(bodyJson);
      } catch { requestBody = bodyText; }
    } catch { requestBody = null; }
  }

  // ✅ 发送请求给 Nebius
  let response: Response | null = null;
  try {
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    headers.set("User-Agent", "Mozilla/5.0");
    headers.delete("Host");
    headers.delete("x-vercel-id");
    headers.delete("x-forwarded-host");
    headers.delete("x-forwarded-for");

    response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      body: requestBody,
      redirect: "follow"
    });
  } catch (error) {
    return jsonResponse({ error: "Bad Gateway", message: "Fetch to upstream failed" }, 502);
  }

  stats.successfulRequests++;
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("X-Proxy-Server", "Vercel Proxy");
  responseHeaders.set("Access-Control-Allow-Origin", "*");

  // 返回原生流式支持 (Edge Runtime 流水线)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });
}

// --- 辅助页面函数 ---
function generateStatusPage(reqUrl: string) {
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  const ok = keyManager!.hasValidKeys() && authManager!.hasValidToken();
  return `<!DOCTYPE html><html><head><title>Nebius Proxy</title><style>body{font-family:sans-serif;margin:40px;background:#111;color:#fff;} .card{background:#222;padding:20px;border-radius:8px;border-left:4px solid ${ok?'#28a745':'#dc3545'};} code{background:#333;padding:2px 6px;border-radius:4px;}</style></head><body><h1>🚀 Nebius Proxy</h1><div class="card"><h2>Status: ${ok ? '✅ RUNNING' : '❌ ERROR'}</h2><p>Uptime: ${uptime}s | Requests: ${stats.totalRequests}</p><p>Keys valid: ${keyManager!.hasValidKeys()}</p><p>Use endpoint: <code>/v1/chat/completions</code> with your PROXY_API_TOKEN</p></div></body></html>`;
}
function htmlResponse(c: string) { return new Response(c, { headers: { "Content-Type": "text/html; charset=utf-8" }}); }
function jsonResponse(d: unknown, s = 200) { return new Response(JSON.stringify(d), { headers: { "Content-Type": "application/json" }, status: s }); }
