/**
 * lib/oss.js —— 阿里云 OSS 最小客户端（V1 签名，只做 PutObject / 签名 URL / Delete）。
 *
 * 为什么不用 SDK：这里只需要三个动作，一个依赖都不引入更稳。
 * 桶是私有的，ASR 需要的是「带签名的临时 URL」，不是公共读。
 */

import crypto from 'node:crypto';

function hmacSha1(secret, text) {
  return crypto.createHmac('sha1', secret).update(text, 'utf8').digest('base64');
}

function md5Base64(buffer) {
  return crypto.createHash('md5').update(buffer).digest('base64');
}

/** OSS 对象键：按段编码，保留斜杠。 */
function encodeKey(key) {
  return String(key)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

export function createOss({ bucket, endpoint, accessKeyId, accessKeySecret, logger }) {
  const host = `https://${bucket}.${endpoint}`;
  const canonicalResource = (key) => `/${bucket}/${key}`;

  function authHeader(method, key, contentType, date, contentMd5 = '') {
    const stringToSign = [method, contentMd5, contentType, date, canonicalResource(key)].join('\n');
    return `OSS ${accessKeyId}:${hmacSha1(accessKeySecret, stringToSign)}`;
  }

  async function putObject(key, buffer, contentType = 'application/octet-stream') {
    const date = new Date().toUTCString();
    const md5 = md5Base64(buffer);
    const response = await fetch(`${host}/${encodeKey(key)}`, {
      method: 'PUT',
      headers: {
        Date: date,
        'Content-Type': contentType,
        'Content-MD5': md5,
        Authorization: authHeader('PUT', key, contentType, date, md5),
      },
      body: buffer,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OSS 上传失败 HTTP ${response.status}：${text.slice(0, 200)}`);
    }
    if (logger && logger.info) logger.info(`[ai-records] 已上传 ${(buffer.length / 1e6).toFixed(1)}MB → ${key}`);
    return { key, url: `${host}/${encodeKey(key)}` };
  }

  /** 生成带签名的临时下载 URL（默认 2 小时）。 */
  function signedUrl(key, expiresSeconds = 7200) {
    const expires = Math.floor(Date.now() / 1000) + Math.max(60, expiresSeconds);
    const stringToSign = ['GET', '', '', String(expires), canonicalResource(key)].join('\n');
    const signature = hmacSha1(accessKeySecret, stringToSign);
    const query = `OSSAccessKeyId=${encodeURIComponent(accessKeyId)}&Expires=${expires}&Signature=${encodeURIComponent(signature)}`;
    return `${host}/${encodeKey(key)}?${query}`;
  }

  async function deleteObject(key) {
    const date = new Date().toUTCString();
    const response = await fetch(`${host}/${encodeKey(key)}`, {
      method: 'DELETE',
      headers: { Date: date, Authorization: authHeader('DELETE', key, '', date) },
    });
    return response.ok;
  }

  return { bucket, endpoint, putObject, signedUrl, deleteObject };
}

/** 从本地 env 文件读取 OSS 配置。 */
export function readOssEnv(file, fs) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const read = (name) => {
      const match = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.+?)\\s*$`, 'm').exec(text);
      return match ? match[1].replace(/^["']|["']$/g, '') : '';
    };
    const bucket = read('OSS_BUCKET');
    const endpoint = read('OSS_ENDPOINT');
    const accessKeyId = read('OSS_ACCESS_KEY_ID');
    const accessKeySecret = read('OSS_ACCESS_KEY_SECRET');
    if (!bucket || !endpoint || !accessKeyId || !accessKeySecret) return null;
    return { bucket, endpoint, accessKeyId, accessKeySecret };
  } catch {
    return null;
  }
}
