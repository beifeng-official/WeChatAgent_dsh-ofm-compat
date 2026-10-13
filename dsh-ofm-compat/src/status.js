/**
 * 只读状态输出：一份 JSON 文件 + 一个仅回环的 HTTP 接口。
 *
 * 用途：WeChatAgent 控制台（或你自己）想知道「现在到底在用哪个模型、为什么选它」。
 * 因为 WeChatAgent 的会话日志会把插件返回的 detail 过滤掉（只留 turn_error），
 * 没有这个状态面就只能靠猜。
 *
 * 安全边界：**只绑定回环地址**，只提供 GET，只读，不接收任何写操作。
 * 非回环 host 一律拒绝，避免误配置把状态面暴露到局域网。
 *
 * @module src/status
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** 原子写：先写临时文件再 rename，避免读到半个 JSON。 */
export function writeStatusFile(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {number} options.port 0 表示不启动
 * @param {string} [options.host]
 * @param {() => object} options.snapshot 返回状态对象
 * @param {() => Promise<object>} [options.probe] 真实跑一次模型调用（POST /probe）
 * @param {(message:string)=>void} [options.log]
 * @returns {{close: () => void, port: () => number}}
 */
export function createStatusServer({ port, host = '127.0.0.1', snapshot, probe, log = () => {} }) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { close: () => {}, port: () => 0 };
  }
  if (!LOOPBACK.has(host)) {
    log(`ofm-compat: 拒绝在非回环地址 ${host} 上启动状态接口`);
    return { close: () => {}, port: () => 0 };
  }

  let boundPort = 0;
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    const pathname = url.split('?')[0];
    const send = (code, body) => {
      const text = `${JSON.stringify(body, null, 2)}\n`;
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
      });
      res.end(text);
    };

    if (pathname === '/probe') {
      // 刻意要求 POST：这个端点会**真实消耗一次模型额度**，
      // 不能让浏览器地址栏或任何预取不小心触发它。
      if (req.method !== 'POST') {
        return send(405, {
          error: 'method_not_allowed',
          hint: 'POST /probe 会真实调用一次模型并消耗额度，因此不接受 GET。',
        });
      }
      if (typeof probe !== 'function') return send(503, { error: 'probe_unavailable' });
      try {
        return send(200, await probe());
      } catch (error) {
        return send(500, { ok: false, error: String(error?.message ?? error) });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'method_not_allowed' });
    if (pathname === '/health') return send(200, { ok: true, plugin: 'ofm-compat', probe: typeof probe === 'function' });
    if (pathname === '/' || pathname === '/status') return send(200, snapshot());
    return send(404, { error: 'not_found', endpoints: ['/status', '/health', 'POST /probe'] });
  });

  server.on('error', (error) => log(`ofm-compat: 状态接口启动失败：${error?.message ?? error}`));
  try {
    server.listen(port, host, () => {
      const address = server.address();
      boundPort = typeof address === 'object' && address ? address.port : 0;
      log(`ofm-compat: 状态接口监听 http://${host}:${boundPort}/status`);
    });
  } catch (error) {
    log(`ofm-compat: 状态接口 listen 抛错：${error?.message ?? error}`);
  }

  return {
    close: () => {
      try {
        server.close();
      } catch {
        /* 关不掉也不该影响卸载 */
      }
    },
    port: () => boundPort,
  };
}
