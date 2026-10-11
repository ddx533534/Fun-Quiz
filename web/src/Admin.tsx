import { useEffect, useRef, useState } from "react";
import { apiUrl } from "./api";

type Batch = { id: string; count: number; created: number; ready?: boolean };
type CodeStatus = "unused" | "partial" | "exhausted" | "disabled" | "missing";
type CodeRow = { code: string; used: number; remaining: number; status: CodeStatus };
type Detail = { batch: Batch; codes: CodeRow[]; summary: { total: number; available: number; exhausted: number; used: number } };
type Props = {
  request: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  admin: boolean; setAdmin: (value: boolean) => void;
  onError: (message: string) => void; notify: (message: string) => void;
};
const labels: Record<CodeStatus, string> = { unused: "未使用", partial: "使用中", exhausted: "已用完", disabled: "已停用", missing: "记录缺失" };
const clean = (value: string) => value.replace(/[-\s]/g, "").toUpperCase();
const date = (seconds: number) => new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false });

export default function Admin({ request, admin, setAdmin, onError, notify }: Props) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [generated, setGenerated] = useState(0);
  const [manualCopy, setManualCopy] = useState("");
  const pendingBatch = useRef("");
  const locked = useRef(false);
  const generation = useRef(0);
  function clear() { setBatches([]); setDetail(null); setCursor(null); setGenerated(0); setManualCopy(""); setQuery(""); setFilter("all"); setPage(1); }
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); onError("");
    try { await action(); }
    catch (error) {
      const message = error instanceof Error ? error.message : "加载失败，请重试";
      if (/请先登录管理端|会话已过期/.test(message)) { clear(); setAdmin(false); }
      onError(message);
    } finally { locked.current = false; setBusy(false); }
  }
  async function loadCodes(id: string) {
    const version = generation.current;
    const data = await request<Detail>("/admin/batches/" + id + "/codes");
    if (version !== generation.current) return;
    setDetail(data); setQuery(""); setFilter("all"); setPage(1); setManualCopy("");
  }
  async function loadBatches(more = false, preferred?: string) {
    const version = generation.current;
    const data = await request<{ batches: Batch[]; next_cursor: string | null }>("/admin/batches" + (more && cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
    if (version !== generation.current) return;
    setBatches(previous => {
      const all = more ? [...previous, ...data.batches] : data.batches;
      return [...new Map(all.map(b => [b.id, b])).values()].sort((a, b) => b.created - a.created);
    });
    setCursor(data.next_cursor);
    if (!more) {
      const id = preferred || detail?.batch.id || data.batches.find(b => b.ready)?.id;
      if (id) await loadCodes(id); else setDetail(null);
    }
  }
  useEffect(() => {
    generation.current++;
    if (admin) void run(() => loadBatches()); else clear();
    return () => { generation.current++; };
  }, [admin]);
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); notify("测评码已复制"); }
    catch { setManualCopy(text); }
  }
  const rows = (detail?.codes || []).filter(row =>
    clean(row.code).includes(clean(query)) && (filter === "all" || row.status === filter));
  const pages = Math.max(1, Math.ceil(rows.length / 25));
  const currentPage = Math.min(page, pages);
  const visible = rows.slice((currentPage - 1) * 25, currentPage * 25);
  if (!admin) return <main className="center"><div className="entry-card">
    <span className="eyebrow">小馆管理室</span><h1>测评码管理</h1>
    <p>登录后查看已有测评码、使用次数和历史批次。</p>
    <form onSubmit={event => { event.preventDefault(); void run(async () => {
      await request("/admin/login", "POST", { key }); setKey(""); setAdmin(true);
    }); }}>
      <label htmlFor="admin-key">管理密钥</label>
      <input id="admin-key" type="password" value={key} onChange={event => setKey(event.target.value)} autoComplete="current-password" required />
      <button disabled={busy} className="primary">登录管理端</button>
    </form>
  </div></main>;
  return <main className="admin-page" aria-busy={busy}>
    <div className="admin-heading">
      <div><span className="eyebrow">小馆管理室</span><h1>测评码管理</h1><p>四款测评与 JEV 通用 · 每个码累计生成3次结果后用完</p></div>
      <div className="admin-actions">
        <button className="secondary" disabled={busy} onClick={() => void run(() => loadBatches())}>刷新列表</button>
        <button className="quiet" disabled={busy} onClick={() => void run(async () => { await request("/admin/logout", "POST", {}); clear(); setAdmin(false); })}>退出管理端</button>
      </div>
    </div>
    <div className="admin-create">
      <div><strong>准备下一批测评码</strong><p>历史测评码持续保留，可以随时查看、复制或导出。</p></div>
      <button className="primary" disabled={busy} onClick={() => void run(async () => {
        pendingBatch.current ||= crypto.randomUUID();
        const batch = await request<{ id: string; count: number }>("/admin/batches", "POST", { count: 100, request_key: pendingBatch.current });
        pendingBatch.current = ""; setGenerated(batch.count); await loadBatches(false, batch.id);
      })}>批量生成100个测评码</button>
    </div>
    {generated > 0 && <div className="admin-success" role="status">已生成 {generated} 个测评码</div>}
    <div className="admin-layout">
      <aside className="admin-batches" aria-label="历史批次">
        <h2>历史批次 <small>{batches.length}</small></h2>
        {batches.length === 0 && <p className="admin-empty">{busy ? "正在读取历史批次…" : "还没有测评码，先生成第一批吧。"}</p>}
        {batches.map(batch => <button key={batch.id} className={"admin-batch" + (detail?.batch.id === batch.id ? " selected" : "")} disabled={busy || !batch.ready} onClick={() => void run(() => loadCodes(batch.id))}>
          <strong>{date(batch.created)}</strong><span>{batch.count} 个测评码 · {batch.ready ? "已生成" : "未完成"}</span><small>批次 {batch.id.slice(0, 8)}</small>
        </button>)}
        {cursor && <button className="quiet" disabled={busy} onClick={() => void run(() => loadBatches(true))}>加载更多批次</button>}
      </aside>
      <section className="admin-codes" aria-label="测评码列表">
        {!detail ? <div className="admin-empty">{busy ? "正在加载测评码…" : "选择批次查看已有测评码"}</div> : <>
          <div className="admin-panel-heading"><div><h2>本批次测评码</h2><p>{date(detail.batch.created)} · 批次 {detail.batch.id.slice(0, 8)}</p></div>
            <a className="secondary" href={apiUrl("/admin/batches/" + detail.batch.id + "/export")}>下载测评码 CSV</a>
          </div>
          <div className="admin-stats">
            {[["测评码总数", detail.summary.total], ["仍可使用", detail.summary.available], ["已用完", detail.summary.exhausted], ["累计生成结果", detail.summary.used]].map(([label, count]) => <div key={label}><span>{label}</span><strong>{count}</strong></div>)}
          </div>
          <div className="admin-filters">
            <label><span>搜索测评码</span><input value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="输入本批次测评码或其中一部分" autoComplete="off" /></label>
            <label><span>使用状态</span><select value={filter} onChange={event => { setFilter(event.target.value); setPage(1); }}><option value="all">全部状态</option>{Object.entries(labels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <button className="secondary" disabled={!visible.length} onClick={() => void copy(visible.map(row => row.code).join("\n"))}>复制当前页</button>
          </div>
          <p className="admin-count">筛选到 {rows.length} 个测评码 · 次数以刷新时的数据为准</p>
          <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>测评码</th><th>已使用</th><th>剩余</th><th>状态</th><th>操作</th></tr></thead><tbody>
            {visible.map(row => <tr key={row.code} data-code={row.code}><td><code>{row.code}</code></td><td>{row.used} 次</td><td>{row.remaining} 次</td><td><span className={"code-status " + row.status}>{labels[row.status]}</span></td><td><button className="quiet" onClick={() => void copy(row.code)}>复制</button></td></tr>)}
          </tbody></table></div>
          {!rows.length && <p className="admin-empty">没有符合条件的测评码</p>}
          <div className="admin-pagination"><button className="secondary" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button><span>第 {currentPage} / {pages} 页</span><button className="secondary" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button></div>
          {manualCopy && <label className="admin-manual-copy">浏览器未允许自动复制，请选中下方内容复制<textarea readOnly value={manualCopy} rows={4} autoFocus onFocus={event => event.currentTarget.select()} /></label>}
        </>}
      </section>
    </div>
  </main>;
}
