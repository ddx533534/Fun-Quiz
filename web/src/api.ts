// Preview authorization must accompany API requests as well as the document.
// Never put temporary preview credentials into permanent result/share URLs.
export function apiUrl(path: string, pageUrl = window.location.href): string {
  return siteUrl('/api' + path, pageUrl);
}

export function siteUrl(path: string, pageUrl = window.location.href): string {
  const page = new URL(pageUrl);
  const target = new URL(path, page.origin);
  if (target.origin !== page.origin) throw new Error('Only same-origin routes are supported');
  if (/\.edgeone\.(dev|app)$/.test(page.hostname)) {
    for (const name of ['eo_token', 'eo_time']) {
      const value = page.searchParams.get(name);
      if (value) target.searchParams.set(name, value);
    }
  }
  return target.pathname + target.search;
}

export async function readApiResponse<T>(res: Response): Promise<T> {
  if (!res.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('访问验证未通过。若使用 Makers 临时预览链接，请在控制台重新生成链接后打开。');
    }
    throw new Error('测评接口暂时不可用，请稍后重试。管理员请检查后端函数部署和接口路由。');
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('测评接口返回异常，请稍后重试。');
  }
  if (!res.ok) {
    throw new Error(typeof data?.detail === 'string' ? data.detail : '请求未完成，请稍后重试。');
  }
  return data as T;
}
