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
    this.logKeyStatus();
  }

  private loadKeysFromEnv(): void {
    // 兼容 Nebius 及旧版变量名
    const envSources =['NEBIUS_API_KEYS', 'GMI_API_KEYS', 'API_KEYS'];

    console.log("🔍 开始加载环境变量...");
    
    for (const envVar of envSources) {
      const keysStr = process.env[envVar];
      if (keysStr) {
        const cleanKeysStr = keysStr.replace(/^["']|["']$/g, '');
        const keyArray = cleanKeysStr.split(',')
          .map(key => key.trim())
          .filter(key => key.length > 0);
          
        for (let i = 0; i < keyArray.length; i++) {
          const key = keyArray[i];
          // ✅ 针对 Nebius 的验证机制
          const isValid = this.isValidAPIKey(key);
          if (isValid) {
            this.apiKeys.push(key);
          }
        }
        
        if (this.apiKeys.length > 0) {
          console.log(`✅ 从 ${envVar} 成功加载 ${this.apiKeys.length} 个有效的 API keys`);
          break;
        }
      }
    }

    if (this.apiKeys.length === 0) {
      for (let i = 1; i <= 20; i++) {
        const envVar = `NEBIUS_API_KEY_${i}`;
        const key = process.env[envVar];
        if (key && this.isValidAPIKey(key.trim())) {
          this.apiKeys.push(key.trim());
        }
      }
    }

    if (this.apiKeys.length === 0) {
      this.loadError = 'No valid API keys found! Please set NEBIUS_API_KEYS in Vercel.';
      console.error('❌ 没有找到有效的 API keys!');
    }
  }

  private isValidAPIKey(key: string): boolean {
    // ⚠️ 关键 Bug 修复：Nebius Token 不同于以前的 JWT，没有强制 3段式结构，只要是标准长字符串即有效！
    const isValid = key.length > 15;
    if (!isValid) {
      console.log(`❌ 无效的 API Key 格式，长度: ${key.length}`);
    }
    return isValid;
  }

  hasValidKeys(): boolean {
    return this.apiKeys.length > 0;
  }

  getNextAPIKey(): string {
    if (!this.hasValidKeys()) throw new Error('No valid API keys available');
    const timeSlot = Math.floor(Date.now() / 1000);
    const index = (timeSlot + this.requestCounter) % this.apiKeys.length;
    this.requestCounter++;
    return this.apiKeys[index];
  }

  getPublicKeyStatus(): { total: number; usage: number[]; error?: string; hasKeys: boolean } {
    const result = {
      total: this.apiKeys.length,
      usage: new Array(this.apiKeys.length).fill(0),
      hasKeys: this.apiKeys.length > 0
    };
    if (this.loadError && this.apiKeys.length === 0) {
      return { ...result, error: 'API keys configuration error - check Vercel Env' };
    }
    return result;
  }

  private logKeyStatus(): void {
    if (this.loadError) return;
    console.log(`🔑 成功加载总计 API Keys: ${this.apiKeys.length}`);
  }
}

// ✅ 代理访问认证管理器
class ProxyAuthManager {
  private customToken: string | null = null;

  constructor() {
    this.loadCustomToken();
  }

  private loadCustomToken(): void {
    const token = process.env.PROXY_API_TOKEN;
    if (token && token.trim().length > 0) {
      this.customToken = token.trim();
    } else {
      console.error('❌ PROXY_API_TOKEN 未设置或为空！');
    }
  }

  validateToken(token: string): boolean {
    return !!this.customToken && this.customToken === token;
  }

  hasValidToken(): boolean {
    return this.customToken !== null;
  }
}

interface RequestStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  startTime: number;
  authFailures: number;
  rateLimitHits: number;
}

const stats: RequestStats = {
  totalRequests: 0, successfulRequests: 0, failedRequests: 0,
  startTime: Date.now(), authFailures: 0, rateLimitHits: 0
};

// 全局懒加载以适应 Vercel Edge 的环境注入生命周期
let keyManager: APIKeyManager | null = null;
let authManager: ProxyAuthManager | null = null;

// ✅ 上游 Nebius 官方 Token Factory 目标地址 (根据最新文档)
const UPSTREAM_BASE = 'https://api.tokenfactory.eu-west1.nebius.com';

export default async function handler(request: Request): Promise<Response> {
  // 确保管理类被正确初始化
  if (!keyManager) keyManager = new APIKeyManager();
  if (!authManager) authManager = new ProxyAuthManager();

  const url = new URL(request.url);
  const pathname = url.pathname;
  const search = url.search;

  stats.totalRequests++;

  // ✅ CORS 跨域预检处理（前端调用不报错）
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

  // ✅ 状态页及 robots.txt 处理
  if ((pathname === '/' || pathname === '/index.html' || pathname === '/api/index') && request.method === 'GET' && !request.headers.get('Authorization')) {
    return htmlResponse(generateStatusPage(request.url));
  }

  if (pathname === '/status' && request.method === 'GET') {
    return jsonResponse({
      service: "Vercel Nebius Proxy Server",
      version: "3.0.0",
      uptime: Date.now() - stats.startTime,
      stats,
      keyStatus: keyManager.getPublicKeyStatus(),
      proxyToken: authManager.hasValidToken() ? 'configured' : 'not configured'
    });
  }

  if (pathname === '/robots.txt' && request.method === 'GET') {
    return textResponse("User-agent: *\nDisallow: /");
  }

  // ✅ 拦截性鉴权
  if (!authManager.hasValidToken()) {
    return jsonResponse({ error: "Service Unavailable", message: "Proxy token not configured" }, 503);
  }
  if (!keyManager.hasValidKeys()) {
    return jsonResponse({ error: "Service Unavailable", message: "No valid Nebius API keys configured" }, 503);
  }
  if (!verifyAuth(request, authManager)) {
    stats.failedRequests++; stats.authFailures++;
    return jsonResponse({ error: "Unauthorized", message: "Valid Bearer token required" }, 401);
  }

  // ✅ 构造目标 URL
  const targetUrl = `${UPSTREAM_BASE}${pathname}${search}`;
  
  let apiKey: string;
  try {
    apiKey = keyManager.getNextAPIKey();
  } catch (error) {
    stats.failedRequests++;
    return jsonResponse({ error: "Service Unavailable", message: "No API keys available" }, 503);
  }

  // ✅ 预处理请求体 - 防止参数冲突
  let requestBody: BodyInit | null = null;
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    try {
      const bodyText = await request.clone().text();
      if (bodyText) {
        try {
          const bodyJson = JSON.parse(bodyText);
          // Nebius (vLLM 底层) 当 top_p 和 temperature 同时被覆盖修改时容易产生冲突报错
          if (bodyJson.temperature !== undefined && bodyJson.top_p !== undefined) {
            delete bodyJson.top_p;
          }
          requestBody = JSON.stringify(bodyJson);
        } catch {
          requestBody = bodyText;
        }
      }
    } catch {
      requestBody = null;
    }
  }

  // ✅ 高可用重试机制
  let retries = 3;
  let response: Response | null = null;

  while (retries > 0) {
    try {
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${apiKey}`);
      headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0");
      headers.set("Accept", "application/json");
      
      // 清理 Vercel 的特定追踪头，防止上游进行识别阻断
      headers.delete("Host");
      headers.delete("x-vercel-id");
      headers.delete("x-vercel-ip-country");
      headers.delete("x-forwarded-host");
      headers.delete("x-forwarded-for");

      response = await fetch(targetUrl, {
        method: request.method,
        headers: headers,
        body: requestBody,
        redirect: "follow"
      });

      if (response.status === 401 || response.status === 403) {
        stats.authFailures++; retries--;
        await new Promise(res => setTimeout(res, 1000 * (4 - retries)));
        continue;
      }

      if (response.status === 429) {
        stats.rateLimitHits++; retries--;
        await new Promise(res => setTimeout(res, 2000 * (4 - retries)));
        continue;
      }

      break;
    } catch (error) {
      retries--;
      await new Promise(res => setTimeout(res, 1500 * (4 - retries)));
    }
  }

  if (!response) {
    stats.failedRequests++;
    return jsonResponse({ error: "Bad Gateway", message: "All retries failed" }, 502);
  }

  stats.successfulRequests++;
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("X-Proxy-Server", "Vercel Nebius Proxy");
  responseHeaders.set("X-API-Key-Rotation", "Enabled");
  responseHeaders.set("Access-Control-Allow-Origin", "*"); // 全局允许跨域

  // Native streaming return (Vercel Edge 自动支持 response.body 流透传)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });
}

function verifyAuth(request: Request, authManager: ProxyAuthManager): boolean {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;
  return authManager.validateToken(authHeader.replace('Bearer ', '').trim());
}

function generateStatusPage(requestUrl: string): string {
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  const keyStatus = keyManager!.getPublicKeyStatus();
  const hasProxyToken = authManager!.hasValidToken();
  const baseUrl = new URL(requestUrl).origin;
  const successRate = stats.totalRequests > 0 ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(1) : '0';

  return `
<!DOCTYPE html>
<html>
<head>
    <title>Nebius Vercel Proxy</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: linear-gradient(135deg, #000 0%, #333 100%); color: #333; min-height: 100vh; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .header { text-align: center; margin-bottom: 30px; }
        .status { color: #28a745; font-weight: bold; font-size: 18px; }
        .error { color: #dc3545; font-weight: bold; font-size: 18px; }
        .card { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 15px 0; border-left: 4px solid #000; }
        .success-card { border-left: 4px solid #28a745; background: #d4edda; }
        .error-card { border-left: 4px solid #dc3545; background: #f8d7da; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; }
        .stat-item { text-align: center; padding: 15px; background: white; border-radius: 6px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
        .stat-number { font-size: 24px; font-weight: bold; color: #000; }
        .stat-label { font-size: 14px; color: #666; margin-top: 5px; }
        .endpoint { background: #e9ecef; padding: 15px; border-radius: 6px; font-family: monospace; font-size: 14px; margin: 10px 0; overflow-x: auto; }
        h1 { margin: 0; }
        .version { color: #666; font-size: 14px; }
        .footer { text-align: center; margin-top: 30px; color: #aaa; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 Nebius Proxy Server</h1>
            <p class="version">v3.0.0 (Powered by Vercel Edge)</p>
            ${keyStatus.hasKeys && hasProxyToken ? '<p class="status">✅ Service Running Normally</p>' : '<p class="error">❌ Service Configuration Error</p>'}
        </div>
        <div class="card">
            <h2>📊 Service Statistics</h2>
            <div class="stats-grid">
                <div class="stat-item"><div class="stat-number">${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m</div><div class="stat-label">Uptime</div></div>
                <div class="stat-item"><div class="stat-number">${stats.totalRequests}</div><div class="stat-label">Total Requests</div></div>
                <div class="stat-item"><div class="stat-number">${stats.successfulRequests}</div><div class="stat-label">Successful</div></div>
                <div class="stat-item"><div class="stat-number">${successRate}%</div><div class="stat-label">Success Rate</div></div>
            </div>
        </div>
        <div class="card ${keyStatus.hasKeys ? 'success-card' : 'error-card'}">
            <h2>🔑 API Keys Status</h2>
            <p><strong>Total Keys:</strong> ${keyStatus.total}</p>
            <p>${keyStatus.hasKeys ? '✅ Load balancing active' : '❌ No valid API keys configured'}</p>
        </div>
        ${keyStatus.hasKeys && hasProxyToken ? `
        <div class="card">
            <h2>📡 API Usage</h2>
            <div class="endpoint">
                <strong>Base URL:</strong><br>${baseUrl}<br><br>
                <strong>Example:</strong><br>POST ${baseUrl}/v1/chat/completions<br><br>
                <strong>Headers:</strong><br>Authorization: Bearer YOUR_PROXY_TOKEN<br>Content-Type: application/json
            </div>
        </div>` : ''}
    </div>
    <div class="footer"><p>Powered by Vercel Edge ▲ | Built for Boss</p></div>
</body>
</html>`;
}

function htmlResponse(content: string): Response { return new Response(content, { headers: { "Content-Type": "text/html; charset=utf-8" }}); }
function textResponse(content: string, status = 200): Response { return new Response(content, { headers: { "Content-Type": "text/plain; charset=utf-8" }, status }); }
function jsonResponse(data: unknown, status = 200): Response { return new Response(JSON.stringify(data, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8" }, status }); }
