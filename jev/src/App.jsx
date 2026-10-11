import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleHelp, KeyRound, Plus, Sparkles, X } from "lucide-react";
import { apiUrl, sessionUrl, siteUrl } from "./api.js";

const defaultOptions = ["", ""];
const PACK_SIZE = 3;


export default function App() {
  const [mode, setMode] = useState("whether");
  const [question, setQuestion] = useState("");
  const [context, setContext] = useState("");
  const [options, setOptions] = useState(defaultOptions);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [csrf, setCsrf] = useState("");
  const pendingRequest = useRef(null);
  const [remainingUses, setRemainingUses] = useState(0);
  const [accessState, setAccessState] = useState("checking");
  const [redemptionCode, setRedemptionCode] = useState("");
  const [redeemError, setRedeemError] = useState("");
  const [redeeming, setRedeeming] = useState(false);

  const visibleOptions = useMemo(() => mode === "whether" ? ["要", "不要"] : options, [mode, options]);

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const response = await fetch(sessionUrl());
        const session = await readResponse(response);
        if (cancelled) return;
        setCsrf(session.csrf);
        const credits = await fetch(apiUrl("/credits"));
        if (cancelled) return;
        if (credits.status === 401) { setAccessState("locked"); return; }
        const data = await readResponse(credits);
        if (cancelled) return;
        setRemainingUses(data.remainingUses);
        setAccessState("ready");
      } catch (cause) {
        if (!cancelled) { setRedeemError(cause.message); setAccessState("locked"); }
      }
    }
    restore();
    return () => { cancelled = true; };
  }, []);

  function changeMode(nextMode) {
    setMode(nextMode);
    setResult(null);
    setError("");
  }

  async function redeem(event) {
    event.preventDefault();
    setRedeemError("");
    if (!redemptionCode.trim()) return setRedeemError("请输入订单交付的通用测评码。");

    setRedeeming(true);
    try {
      let csrfToken = csrf;
      if (!csrfToken) {
        const session = await readResponse(await fetch(sessionUrl()));
        csrfToken = session.csrf;
        setCsrf(csrfToken);
      }
      const response = await fetch(apiUrl("/redeem"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ code: redemptionCode }),
      });
      const data = await readResponse(response);
      setRemainingUses(data.remainingUses);
      setRedemptionCode("");
      setAccessState("ready");
    } catch (cause) {
      setRedeemError(cause instanceof Error ? cause.message : "验证失败，请稍后再试。");
    } finally {
      setRedeeming(false);
    }
  }

  function useAnotherCode() {
    pendingRequest.current = null;
    setRemainingUses(0);
    setResult(null);
    setError("");
    setAccessState("locked");
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    setResult(null);

    if (remainingUses <= 0) return setError("这个码的 3 次已经用完，请购买新的次数包。");
    if (!question.trim()) return setError("先写下你要决定的事。");
    if (!context.trim()) return setError("把你知道的情况写下来；某一项不知道，可以直接写“不清楚”。");
    if (mode === "choice" && options.some((item) => !item.trim())) return setError("每个选项都需要一个名字。");

    const input = { mode, question, context, options: mode === "choice" ? options : undefined };
    const fingerprint = JSON.stringify(input);
    if (pendingRequest.current?.fingerprint !== fingerprint) pendingRequest.current = { fingerprint, key: crypto.randomUUID() };
    setLoading(true);
    try {
      const response = await fetch(apiUrl("/decide"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ ...input, request_key: pendingRequest.current.key }),
      });
      if (response.status === 401) setAccessState("locked");
      if (response.status === 409) {
        const credits = await fetch(apiUrl("/credits"));
        if (credits.ok) setRemainingUses((await credits.json()).remainingUses);
      }
      const data = await readResponse(response);
      pendingRequest.current = null;
      setResult(data);
      if (data.status === "success") setRemainingUses(data.remainingUses);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "这次没选出来，请稍后再试。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page-shell">
      <div className="page">
        <header className="header">
          <div className="brand">
            <div className="logo">J</div>
            <div><strong>JEV 帮你选</strong><span>一个问题，一次选择</span></div>
          </div>
          <a className="home-link" href={siteUrl("/")}>← 返回导航</a>
        </header>

        <section className="hero-grid">
          <div className="hero-copy">
            <div className="eyebrow"><Sparkles size={14} /> 不灌鸡汤，只给倾向</div>
            <h1>不写小作文，直接帮你选</h1>
            <p>写下问题和你知道的背景，JEV 直接给出选项倾向。</p>
          </div>

          {accessState === "checking" ? (
            <div className="card access-card">
              <div className="access-icon"><KeyRound size={22} /></div>
              <h2>正在验证使用次数</h2>
              <p>请稍候…</p>
            </div>
          ) : accessState !== "ready" ? (
            <div className="card access-card">
              <div className="access-icon"><KeyRound size={22} /></div>
              <h2>输入通用测评码，开始使用</h2>
              <p>在闲鱼完成下单后，将聊天中收到的通用测评码填在这里。</p>
              <form className="redemption-form" onSubmit={redeem}>
                <input className="code-input" value={redemptionCode} onChange={(event) => setRedemptionCode(event.target.value.toUpperCase())} maxLength={19} autoCapitalize="characters" autoComplete="off" placeholder="例如：ABCD-EFGH-JKLM-NPQR" />
                {redeemError && <div className="error">{redeemError}</div>}
                <button className="submit" disabled={redeeming}>{redeeming ? "正在验证…" : "验证测评码"}</button>
              </form>
              <small className="access-help">四款测评与 JEV 共享每码 3 次机会，成功生成结果才扣次。</small>
            </div>
          ) : (
          <div className="card">
            <div className="tabs">
              <button type="button" className={mode === "whether" ? "active" : ""} onClick={() => changeMode("whether")}>要不要</button>
              <button type="button" className={mode === "choice" ? "active" : ""} onClick={() => changeMode("choice")}>选哪个</button>
            </div>

            <form onSubmit={submit}>
              <label>
                <span className="label">你在纠结什么？</span>
                <textarea className="question-input" value={question} onChange={(event) => setQuestion(event.target.value)} onInput={autoGrow} maxLength={80} rows={1} data-min-rows="1" data-max-rows="4" placeholder={mode === "whether" ? "例：我要不要接受这份新工作？" : "例：我该选哪一个租房方案？"} />
              </label>

              {mode === "choice" && (
                <div className="option-section">
                  <div className="field-head"><span className="label">有哪些选项？</span><small>2–4 个</small></div>
                  {options.map((option, index) => (
                    <div className="option-row" key={index}>
                      <input value={option} placeholder={`选项 ${String.fromCharCode(65 + index)}`} maxLength={48} onChange={(event) => setOptions((items) => items.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} />
                      {options.length > 2 && <button type="button" className="icon-button" onClick={() => setOptions((items) => items.filter((_, itemIndex) => itemIndex !== index))} aria-label="移除选项"><X size={16} /></button>}
                    </div>
                  ))}
                  {options.length < 4 && <button type="button" className="add-button" onClick={() => setOptions((items) => [...items, ""])}><Plus size={16} /> 添加选项</button>}
                </div>
              )}

              <label>
                <span className="label">把你知道的情况告诉 JEV</span>
                <textarea className="context-input" value={context} onChange={(event) => setContext(event.target.value)} onInput={autoGrow} maxLength={1200} rows={3} data-min-rows="3" data-max-rows="10" placeholder="例：我 28 岁，目前月薪 1.5 万；新工作 2 万但通勤多 1 小时。我更在意成长，也担心加班。具体团队氛围不清楚。" />
                <div className="hint"><span>某项不知道可以写“不清楚”；信息越少，结果的置信度越低。</span><span>{context.length}/1200</span></div>
              </label>

              {error && <div className="error">{error}</div>}
              <button className="submit" disabled={loading || remainingUses === 0}>{loading ? "JEV 正在选择…" : remainingUses === 0 ? "本轮 3 次已用完" : "让 JEV 选一下"}</button>
              <div className={`usage-meter ${remainingUses === 0 ? "empty" : ""}`} aria-live="polite">
                <span>通用码剩余次数</span>
                <strong>{remainingUses}<small> / {PACK_SIZE} 次</small></strong>
              </div>
              {remainingUses === 0 && (
                <div className="paywall">
                  <div><strong>这个码的 3 次已经用完</strong><span>请回闲鱼购买下一组，取得新的通用测评码。</span></div>
                  <button type="button" onClick={useAnotherCode}>输入新的测评码</button>
                </div>
              )}
              <p className="disclaimer">仅用于日常辅助决策，不适用于医疗、投资、法律或人身安全等高风险场景。</p>
            </form>

            {result && <ResultCard result={result} options={visibleOptions} />}
          </div>
          )}
        </section>

        <footer>JEV 给出的是选项倾向，不代表真实世界的发生概率。</footer>
      </div>
    </main>
  );
}

async function readResponse(response) {
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("接口暂时不可用，请刷新页面或重新打开 Makers 预览链接。");
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || data.message || "请求失败，请稍后重试。");
  return data;
}

function autoGrow(event) {
  const field = event.currentTarget;
  const computed = window.getComputedStyle(field);
  const lineHeight = Number.parseFloat(computed.lineHeight) || 24;
  const verticalSpace = Number.parseFloat(computed.paddingTop) + Number.parseFloat(computed.paddingBottom) + Number.parseFloat(computed.borderTopWidth) + Number.parseFloat(computed.borderBottomWidth);
  const minRows = Number.parseInt(field.dataset.minRows || "1", 10);
  const maxRows = Number.parseInt(field.dataset.maxRows || "10", 10);
  const minHeight = lineHeight * minRows + verticalSpace;
  const maxHeight = lineHeight * maxRows + verticalSpace;
  field.style.height = "auto";
  const contentHeight = field.scrollHeight;
  field.style.height = `${Math.min(maxHeight, Math.max(minHeight, contentHeight))}px`;
  field.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}

function ResultCard({ result, options }) {
  const [feedback, setFeedback] = useState("");
  if (result.status === "configuration_error") return <div className="notice warning"><strong>JEV 服务尚未配置</strong><span>请稍后再试。</span></div>;
  if (result.status === "insufficient_context") return <div className="notice"><strong><CircleHelp size={18} /> 这次结果不稳定</strong><span>可以补充更多已知信息后再试。</span></div>;

  const ranked = [...(result.options ?? options.map((label, index) => ({ id: `option_${index + 1}`, label, probability: 0 })))].sort((first, second) => second.probability - first.probability);
  const percents = toWholePercents(ranked.map((item) => item.probability));
  const verdict = result.verdict ?? (result.status === "inconclusive" ? "close" : "lean");
  const title = verdict === "recommend" ? `建议选：${result.selectedOptionLabel}` : verdict === "lean" ? `更偏向：${result.selectedOptionLabel}` : "没有明显更优选项";
  const summary = verdict === "recommend" ? "领先幅度和置信度都较明显，可以作为本次选择参考。" : verdict === "lean" ? `JEV 略微偏向“${result.selectedOptionLabel}”，但优势还不明显。` : "各选项比较接近，暂不建议仅凭本次结果决定。";
  return (
    <div className="result">
      <small>JEV 结果</small>
      <h2>{verdict === "close" ? <CircleHelp size={21} /> : <Check size={21} />}{title}</h2>
      <p>{summary}</p>
      <strong className="result-label">选项倾向度</strong>
      <div className="probabilities">
        {ranked.map((option, index) => <div key={option.id}><div className="probability-head"><span>{option.label}</span><span>{percents[index]}%</span></div><div className="bar"><i style={{ width: `${percents[index]}%` }} /></div></div>)}
      </div>
      <p>JEV 置信度 {Math.round((result.confidence ?? 0) * 100)}%</p>
      <div className="feedback"><span>这个结果帮到你了吗？</span><div>{["和我想的一样", "我更想选另一个", "还是没决定"].map((item) => <button type="button" key={item} className={feedback === item ? "chosen" : ""} onClick={() => setFeedback(item)}>{item}</button>)}</div></div>
    </div>
  );
}

function toWholePercents(probabilities) {
  const sum = probabilities.reduce((total, value) => total + Math.max(0, Number(value) || 0), 0);
  if (!sum) return probabilities.map(() => 0);
  const exact = probabilities.map((value) => Math.max(0, Number(value) || 0) / sum * 100);
  const whole = exact.map(Math.floor);
  let remainder = 100 - whole.reduce((total, value) => total + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - whole[index] })).sort((a, b) => b.fraction - a.fraction);
  for (let index = 0; remainder > 0; index += 1, remainder -= 1) whole[order[index].index] += 1;
  return whole;
}
