export function apiUrl(path, pageUrl = window.location.href) {
  return siteUrl('/api/jev' + path, pageUrl);
}
export function sessionUrl(pageUrl = window.location.href) {
  return siteUrl('/api/session', pageUrl);
}
export function siteUrl(path, pageUrl = window.location.href) {
  const page = new URL(pageUrl);
  const target = new URL(path, page.origin);
  if (/\.edgeone\.(dev|app)$/.test(page.hostname)) {
    for (const name of ['eo_token', 'eo_time']) {
      const value = page.searchParams.get(name);
      if (value) target.searchParams.set(name, value);
    }
  }
  return target.pathname + target.search;
}
