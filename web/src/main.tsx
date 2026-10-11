import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type ProductId = "past" | "next" | "cat" | "end";
type Question = {
  id: string;
  text: string;
  options: { key: string; text: string }[];
  display_order: string[];
};
type Product = { id: ProductId; name: string; questions: Question[] };
type Attempt = {
  id: string;
  product: ProductId;
  answers: Record<string, string>;
  revision: number;
  result_id: string | null;
  remaining: number;
  expires: number;
};
type Card = {
  variant_name: string;
  base_name: string;
  core_text: string;
  job: string;
  daily_scene: string;
  signature: string;
  quote: string;
  gentle_reminder: string;
  variant_scene: string;
  suffix_text: string;
  role: string;
};
type Report = {
  product: ProductId;
  product_name: string;
  headline: string;
  mode: string;
  cards: Card[];
  notice: string;
  result_version: string;
};
type Result = { report: Report; share_url: string | null };
const meta: Record<
  ProductId,
  { title: string; subtitle: string; tag: string; icon: string; color: string }
> = {
  past: {
    title: "你的上一世是什么？",
    subtitle: "也许是山里的石头，也许是等月亮的人。",
    tag: "找回你熟悉的灵魂",
    icon: "山",
    color: "#89654b",
  },
  next: {
    title: "你的下一世是什么？",
    subtitle: "下辈子，允许自己换一种活法。",
    tag: "领取下一世入场券",
    icon: "云",
    color: "#577e99",
  },
  cat: {
    title: "你是哪一种流浪猫？",
    subtitle: "街角那么多猫，哪一只偷偷像你？",
    tag: "城市里的一点自由",
    icon: "猫",
    color: "#a07935",
  },
  end: {
    title: "末世来临，你会变成什么动物？",
    subtitle: "世界重新开局，你的本能先醒来。",
    tag: "看看你的生存底牌",
    icon: "鹿",
    color: "#466655",
  },
};
let csrf = "";
async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch("/api" + url, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "网络暂时没连上，请重试");
  return data;
}
function Glyph({ kind }: { kind: ProductId }) {
  return (
    <svg viewBox="0 0 180 140" className="glyph" aria-hidden="true">
      <circle cx="90" cy="70" r="62" fill="currentColor" opacity=".07" />
      {kind === "past" && (
        <>
          <path
            d="M24 112 65 38l32 45 20-33 39 62Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle cx="128" cy="29" r="11" fill="currentColor" opacity=".35" />
          <path
            d="M37 123h106M67 39l-5 37 20-17"
            fill="none"
            stroke="currentColor"
          />
        </>
      )}
      {kind === "next" && (
        <>
          <path
            d="M48 93c-31-2-27-42 0-43 3-33 48-36 56-11 30-8 50 20 35 41-6 10-16 13-31 13Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="m61 110-4 11m31-11-4 11m31-11-4 11"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M74 69q4 5 8 0m13 0q4 5 8 0"
            fill="none"
            stroke="currentColor"
          />
        </>
      )}
      {kind === "cat" && (
        <>
          <path
            d="m52 63-4-30 30 17q14-4 28 0l28-17-3 33q10 18 0 32-13 21-43 18-40-3-36-38Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M70 76h8m25 0h8m-27 15 6 5 6-5m-31-5-26-6m29 16-25 4m67-14 24-6m-27 16 25 5"
            stroke="currentColor"
            fill="none"
            strokeWidth="2"
          />
        </>
      )}
      {kind === "end" && (
        <>
          <path
            d="m78 50-4-23-13-9m13 18-22-2m44 16 7-25 14-10m-13 20 22-2M74 54l17-7 20 12-8 33-14 16-18-24Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="m82 75 3 1m13 0 3-1m-11 20h3"
            stroke="currentColor"
            strokeWidth="3"
          />
          <path
            d="M34 122h115M44 118l-4-25m102 25 4-25"
            stroke="currentColor"
          />
        </>
      )}
    </svg>
  );
}

function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<ProductId | null>(null);
  const [screen, setScreen] = useState<
    "home" | "code" | "ready" | "quiz" | "result" | "admin"
  >("home");
  const [code, setCode] = useState("");
  const [grant, setGrant] = useState("");
  const [remaining, setRemaining] = useState(3);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [resultId, setResultId] = useState("");
  const [publicView, setPublicView] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [poster, setPoster] = useState("");
  const [manualLink, setManualLink] = useState("");
  const [admin, setAdmin] = useState(false);
  const [adminKey, setAdminKey] = useState("");
  const [batch, setBatch] = useState<{ id: string; count: number } | null>(
    null,
  );
  const batchRequest = useRef("");
  const product = products.find((p) => p.id === selected);
  const question = product?.questions[index];
  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3500);
  };
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "请稍后重试");
    } finally {
      setBusy(false);
    }
  }
  async function loadResult(id: string, expectedProduct?: ProductId) {
    const data = await api<Result>("/results/" + id);
    if (expectedProduct && data.report.product !== expectedProduct) {
      throw new Error("这个结果不属于当前测评，请使用原来的结果链接。");
    }
    setResult(data);
    setSelected(data.report.product);
    setResultId(id);
    setPublicView(false);
    setScreen("result");
    history.replaceState(
      null,
      "",
      "/quiz/" + data.report.product + "/result/" + id,
    );
  }
  async function enterProduct(id: ProductId) {
    setSelected(id);
    setCode("");
    setGrant("");
    setAttempt(null);
    setResult(null);
    setPublicView(false);
    setScreen("code");
    setError("");
    const storageKey = "quiz-attempt:" + id;
    const saved = sessionStorage.getItem(storageKey);
    if (!saved) return;
    const a = await api<Attempt>("/attempts/" + saved);
    if (a.product !== id || (!a.result_id && a.expires <= Date.now() / 1000)) {
      sessionStorage.removeItem(storageKey);
      return;
    }
    if (a.result_id) await loadResult(a.result_id, id);
    else {
      setAttempt(a);
      setIndex(Math.min(Object.keys(a.answers).length, 23));
      setScreen("quiz");
    }
  }
  async function openPath() {
    setError("");
    const path = location.pathname;
    const entry = path.match(/^\/quiz\/(past|next|cat|end)\/?$/);
    const resultPath = path.match(
      /^\/quiz\/(past|next|cat|end)\/result\/([^/]+)$/,
    );
    if (entry) await enterProduct(entry[1] as ProductId);
    else if (resultPath)
      await loadResult(resultPath[2], resultPath[1] as ProductId);
    else if (path.startsWith("/s/")) {
      const data = await api<Result>("/share/" + path.slice(3));
      setResult(data);
      setSelected(data.report.product);
      setPublicView(true);
      setScreen("result");
    } else if (path.startsWith("/result/")) await loadResult(path.slice(8));
    else if (path === "/admin") {
      setSelected(null);
      setScreen("admin");
    } else {
      setSelected(null);
      setResult(null);
      setPublicView(false);
      setScreen("home");
      if (path !== "/") setError("没有找到这个测评入口，请从下方选择。");
    }
  }
  useEffect(() => {
    void (async () => {
      try {
        const session = await api<{ csrf: string; admin: boolean }>("/session");
        csrf = session.csrf;
        setAdmin(session.admin);
        const catalog = await api<{ products: Product[] }>("/catalog");
        setProducts(catalog.products);
        // Migrate old preview progress without redirecting another product's entry.
        const legacy = sessionStorage.getItem("quiz-attempt");
        if (legacy) {
          try {
            const a = await api<Attempt>("/attempts/" + legacy);
            sessionStorage.setItem("quiz-attempt:" + a.product, a.id);
            sessionStorage.removeItem("quiz-attempt");
          } catch {
            /* A stale legacy preview must not block a new entry. */
          }
        }
        await openPath();
      } catch (e) {
        setError(e instanceof Error ? e.message : "页面加载失败");
      }
    })();
    const onPopState = () => {
      void openPath().catch((e) =>
        setError(e instanceof Error ? e.message : "页面加载失败"),
      );
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    document.title =
      (selected ? meta[selected].title + " · " : "") + "灵魂小馆";
  }, [selected]);
  useEffect(
    () => () => {
      if (poster) URL.revokeObjectURL(poster);
    },
    [poster],
  );
  function home() {
    setScreen("home");
    setError("");
    setResult(null);
    setPublicView(false);
    setSelected(null);
    if (location.pathname !== "/") history.pushState(null, "", "/");
  }
  function choose(id: ProductId) {
    if (location.pathname !== "/quiz/" + id)
      history.pushState(null, "", "/quiz/" + id);
    void run(() => enterProduct(id));
  }
  function verify() {
    void run(async () => {
      const data = await api<{ grant_id: string; remaining: number }>(
        "/codes/verify",
        "POST",
        { code, product: selected },
      );
      setGrant(data.grant_id);
      setRemaining(data.remaining);
      setCode("");
      setScreen("ready");
    });
  }
  function start() {
    void run(async () => {
      const data = await api<Attempt>("/attempts", "POST", {
        grant_id: grant,
        product: selected,
      });
      setAttempt(data);
      sessionStorage.setItem("quiz-attempt:" + data.product, data.id);
      setIndex(Math.min(Object.keys(data.answers).length, 23));
      setScreen("quiz");
    });
  }
  function answer(key: string) {
    if (!attempt || !question) return;
    void run(async () => {
      const data = await api<Attempt>("/attempts/" + attempt.id, "PATCH", {
        answers: { ...attempt.answers, [question.id]: key },
        revision: attempt.revision,
      });
      setAttempt(data);
      if (index < 23) setIndex(index + 1);
    });
  }
  function finish() {
    if (!attempt) return;
    void run(async () => {
      const data = await api<{ result_id: string; remaining: number }>(
        "/attempts/" + attempt.id + "/complete",
        "POST",
        { answers: attempt.answers },
      );
      setRemaining(data.remaining);
      sessionStorage.removeItem("quiz-attempt:" + attempt.product);
      await loadResult(data.result_id);
    });
  }
  async function copy() {
    if (!result?.share_url) return;
    try {
      await navigator.clipboard.writeText(result.share_url);
      notify("结果链接已复制");
    } catch {
      setManualLink(result.share_url);
    }
  }
  async function save() {
    if (!result) return;
    void run(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1080;
      canvas.height = 1920;
      const c = canvas.getContext("2d");
      if (!c) throw new Error("当前浏览器无法生成图片");
      const m = meta[result.report.product],
        card = result.report.cards[0];
      c.fillStyle = "#f6f2e9";
      c.fillRect(0, 0, 1080, 1920);
      c.fillStyle = m.color;
      c.fillRect(0, 0, 1080, 18);
      c.textAlign = "center";
      c.fillStyle = m.color;
      c.font = "30px sans-serif";
      c.fillText("灵 魂 小 馆  /  人 间 身 份 档 案", 540, 115);
      c.font = "36px sans-serif";
      c.fillText(result.report.product_name, 540, 205);
      c.font = "bold 64px sans-serif";
      let y = 300;
      const wrap = (value: string, width: number, line: number) => {
        let part = "";
        for (const char of value) {
          if (char === "\n" || c.measureText(part + char).width > width) {
            c.fillText(part, 540, y);
            y += line;
            part = char === "\n" ? "" : char;
          } else part += char;
        }
        if (part) {
          c.fillText(part, 540, y);
          y += line;
        }
      };
      wrap(result.report.headline, 900, 83);
      y += 20;
      const svg = document.querySelector(".result-title .glyph");
      if (svg) {
        const illustration = new Image();
        const markup = new XMLSerializer()
          .serializeToString(svg)
          .replace(/currentColor/g, m.color);
        await new Promise<void>((resolve, reject) => {
          illustration.onload = () => resolve();
          illustration.onerror = () => reject(new Error("插画生成失败"));
          illustration.src =
            "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
        });
        c.drawImage(illustration, 360, y, 360, 280);
      }
      y += 335;
      c.font = "32px sans-serif";
      c.fillStyle = "#444a40";
      wrap(card.quote, 820, 55);
      y += 65;
      c.font = "26px sans-serif";
      wrap(card.job, 840, 46);
      y += 45;
      wrap(card.variant_scene, 840, 46);
      y += 55;
      c.fillStyle = m.color;
      c.font = "bold 28px sans-serif";
      wrap("给这一世的你", 840, 46);
      c.fillStyle = "#444a40";
      c.font = "27px sans-serif";
      wrap(card.gentle_reminder, 840, 48);
      if (result.report.cards.length > 1) {
        y += 45;
        c.font = "23px sans-serif";
        wrap(
          "你身上还有：" +
            result.report.cards
              .slice(1, 4)
              .map((v) => v.variant_name)
              .join(" · "),
          860,
          40,
        );
        if (result.report.cards.length > 4) {
          wrap("更多并列身份，请查看完整结果页。", 860, 40);
        }
      }
      c.fillStyle = "#868b7f";
      c.font = "22px sans-serif";
      c.fillText("趣味自我探索 · 文学身份不代表心理诊断或真实前世", 540, 1820);
      c.fillText(
        "灵魂小馆  /  固定结果版本 " + result.report.result_version,
        540,
        1870,
      );
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("图片生成失败"))),
          "image/png",
        ),
      );
      const file = new File(
        [blob],
        "灵魂小馆-" + result.report.headline + ".png",
        { type: "image/png" },
      );
      // Sharing must be a separate user gesture after asynchronous rendering.
      setPoster(URL.createObjectURL(blob));
      (window as Window & { quizPoster?: File }).quizPoster = file;
    });
  }
  async function shareImage() {
    const file = (window as Window & { quizPoster?: File }).quizPoster;
    if (!file) return;
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "我的人间身份档案" });
      } else {
        const a = document.createElement("a");
        a.href = poster;
        a.download = file.name;
        a.click();
        notify("若没有下载，请长按图片保存");
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError"))
        notify("请长按图片，选择保存到相册");
    }
  }
  const back = () => {
    setError("");
    if (screen === "quiz") {
      if (index > 0) setIndex(index - 1);
      else home();
    } else home();
  };
  return (
    <div
      className={"app theme-" + (selected || result?.report.product || "past")}
    >
      <header>
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            home();
          }}
          className="brand"
        >
          <span className="brand-mark">灵</span>
          <span>
            灵魂小馆<small>SOUL ATLAS</small>
          </span>
        </a>
        <button className="quiet" onClick={back}>
          {screen === "home" ? "人间身份档案" : "← 返回"}
        </button>
      </header>
      {error && (
        <div role="alert" className="error">
          {error}
          <button className="quiet" onClick={() => setError("")}>
            关闭
          </button>
        </div>
      )}
      {screen === "home" && (
        <main className="home">
          <div className="hero">
            <span className="eyebrow">给忙着做人、偶尔想逃跑的你</span>
            <h1>
              如果换一种身份，
              <br />
              你会是谁<span>？</span>
            </h1>
            <p>
              用24个生活片段，认出藏在你心里的另一个自己。
              <br />
              不用变得更好，先看看自己有多有趣。
            </p>
            <div className="hero-stamp">
              本日营业
              <br />
              <b>接待各种灵魂</b>
            </div>
          </div>
          <div className="catalog">
            {products.map((p) => (
              <a
                className={"product product-" + p.id}
                key={p.id}
                href={"/quiz/" + p.id}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  choose(p.id);
                }}
              >
                <div className="product-top">
                  <span>{meta[p.id].tag}</span>
                  <span>0{products.indexOf(p) + 1}</span>
                </div>
                <Glyph kind={p.id} />
                <h2>{meta[p.id].title}</h2>
                <p>{meta[p.id].subtitle}</p>
                <div className="product-foot">
                  <span>24道题 · 约5分钟</span>
                  <b>打开档案 ↗</b>
                </div>
              </a>
            ))}
          </div>
          <div className="home-note">
            <span>✦ 回答相同，身份相同</span>
            <span>✦ 可回到上一题修改</span>
            <span>✦ 保存专属结果卡</span>
          </div>
        </main>
      )}
      {screen === "code" && selected && (
        <main className="center">
          <div className="entry-card">
            <Glyph kind={selected} />
            <span className="eyebrow">你的故事，从这里开始</span>
            <h1>{meta[selected].title}</h1>
            <p>
              请输入通用测评码，四款测评都可以使用。
              <br />
              每个码有3次完整测评机会，生成结果后才扣次。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                verify();
              }}
            >
              <label htmlFor="code">测评码</label>
              <input
                id="code"
                autoComplete="off"
                autoCapitalize="characters"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                maxLength={24}
                required
              />
              <button className="primary" disabled={busy || !code.trim()}>
                {busy ? "正在验证…" : "解锁我的档案 →"}
              </button>
            </form>
            <small>四款共享3次机会，可测不同款，也可重复测同一款。</small>
          </div>
        </main>
      )}
      {screen === "ready" && selected && (
        <main className="center">
          <div className="entry-card">
            <Glyph kind={selected} />
            <span className="eyebrow">
              档案已解锁 · 四款共剩 {remaining} 次
            </span>
            <h1>把真实的你带进来。</h1>
            <p>
              请选择最接近你平常反应的答案。
              <br />
              不用猜哪一个更好，也不用扮演理想中的自己。
            </p>
            <div className="rules">
              <p>24道生活题，没有标准答案。</p>
              <p>可以返回修改，进度会自动保存。</p>
              <p>结果采用固定匹配规则，供趣味自我探索。</p>
            </div>
            <button className="primary" onClick={start} disabled={busy}>
              {busy ? "准备档案…" : "开始测评 →"}
            </button>
          </div>
        </main>
      )}
      {screen === "quiz" && question && attempt && (
        <main className="quiz">
          <div className="progress-label">
            <span>{selected && meta[selected].tag}</span>
            <span>{index + 1} / 24</span>
          </div>
          <div className="progress">
            <i style={{ width: ((index + 1) / 24) * 100 + "%" }} />
          </div>
          <article className="question">
            <span className="eyebrow">
              生活片段 {String(index + 1).padStart(2, "0")}
            </span>
            <h1>{question.text}</h1>
            <div className="options">
              {question.display_order.map((key, i) => {
                const option = question.options.find((o) => o.key === key)!;
                return (
                  <button
                    key={key}
                    disabled={busy}
                    className={
                      attempt.answers[question.id] === key ? "chosen" : ""
                    }
                    onClick={() => answer(key)}
                  >
                    <span>{String.fromCharCode(65 + i)}</span>
                    <div>{option.text}</div>
                    <b>{attempt.answers[question.id] === key ? "✓" : "↗"}</b>
                  </button>
                );
              })}
            </div>
            <div className="quiz-actions">
              <button
                className="secondary"
                disabled={index === 0 || busy}
                onClick={() => setIndex(index - 1)}
              >
                ← 上一题
              </button>
              <small>
                {busy ? "正在保存…" : "选择后自动继续 · 可返回修改"}
              </small>
              {index < 23 ? (
                <button
                  className="secondary"
                  disabled={!attempt.answers[question.id] || busy}
                  onClick={() => setIndex(index + 1)}
                >
                  下一题 →
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={Object.keys(attempt.answers).length !== 24 || busy}
                  onClick={finish}
                >
                  {busy ? "正在生成…" : "查看我的身份 →"}
                </button>
              )}
            </div>
          </article>
        </main>
      )}
      {screen === "result" && result && (
        <main className="result">
          <span className="eyebrow">
            {publicView ? "朋友的人间身份档案" : "你的人间身份档案"} /{" "}
            {result.report.product_name}
          </span>
          <div className="result-title">
            <Glyph kind={result.report.product} />
            <h1>{result.report.headline}</h1>
            <p>
              {result.report.mode === "equal"
                ? "你的回答落在几种身份的交汇处，它们都属于你。"
                : result.report.mode === "near"
                  ? "这份身份最接近你的回答，也保留了相邻的一面。"
                  : "一个有点熟悉，又有点意外的你。"}
            </p>
          </div>
          {result.report.cards.map((card, i) => (
            <article className="dossier" key={i}>
              <span className="eyebrow">
                {card.role === "alternative"
                  ? "你的另一面"
                  : card.role === "equal"
                    ? "并列身份 " + (i + 1)
                    : "灵魂档案 01"}
              </span>
              <h2>{card.variant_name}</h2>
              <blockquote>{card.quote}</blockquote>
              <p className="job">{card.job}</p>
              <div className="story">
                {card.core_text
                  .split("\n")
                  .map(
                    (line, j) =>
                      line.trim() && <p key={j}>{line.replace(/\*\*/g, "")}</p>,
                  )}
              </div>
              <div className="scene">
                <span>如果把你拍成一段电影</span>
                <p>{card.variant_scene}</p>
                <p>{card.daily_scene}</p>
              </div>
              <div className="signature">
                <span>你的灵魂签名</span>
                <p>{card.signature}</p>
              </div>
              <div className="reminder">
                <span>给这一世的你</span>
                <p>{card.gentle_reminder}</p>
              </div>
            </article>
          ))}
          <div className="result-actions">
            <button className="primary" onClick={save} disabled={busy}>
              {busy ? "正在画你的卡片…" : "↓ 保存结果图片"}
            </button>
            {result.share_url && (
              <button className="secondary" onClick={() => void copy()}>
                复制结果链接 ↗
              </button>
            )}
            <button
              className="quiet"
              onClick={() => choose(result.report.product)}
            >
              {publicView ? "我也测这款" : "再测一次这款"}
            </button>
            <button className="quiet" onClick={home}>
              查看四款测评
            </button>
            {!publicView && result.share_url && (
              <button
                className="quiet"
                onClick={() =>
                  void run(async () => {
                    await api("/results/" + resultId + "/share", "DELETE");
                    setResult({ ...result, share_url: null });
                    notify("分享链接已取消");
                  })
                }
              >
                取消公开分享
              </button>
            )}
          </div>
          <p className="footnote">
            {result.report.notice}
            <br />
            这是文学化的趣味自我探索，不是心理诊断或前世预测。问卷尚未经心理测量验证。
          </p>
        </main>
      )}
      {screen === "admin" && (
        <main className="center">
          <div className="entry-card">
            <span className="eyebrow">小馆管理室</span>
            <h1>测评码管理</h1>
            {!admin ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await api("/admin/login", "POST", { key: adminKey });
                    setAdminKey("");
                    setAdmin(true);
                  });
                }}
              >
                <label htmlFor="admin-key">管理密钥</label>
                <input
                  id="admin-key"
                  type="password"
                  value={adminKey}
                  onChange={(e) => setAdminKey(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                <button disabled={busy} className="primary">
                  登录管理端
                </button>
              </form>
            ) : (
              <>
                <p>每个码四款通用，累计生成3次结果后用完。</p>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (!batchRequest.current)
                        batchRequest.current = crypto.randomUUID();
                      setBatch(
                        await api("/admin/batches", "POST", {
                          count: 100,
                          request_key: batchRequest.current,
                        }),
                      );
                    })
                  }
                >
                  {busy
                    ? "生成中…"
                    : batch
                      ? "重新取得本批次"
                      : "批量生成100个测评码"}
                </button>
                {batch && (
                  <div className="batch">
                    <b>已生成 {batch.count} 个测评码</b>
                    <p>请在24小时内下载并妥善保管。重复点击不会重复生成。</p>
                    <a
                      className="secondary"
                      href={"/api/admin/batches/" + batch.id + "/export"}
                    >
                      下载测评码 CSV
                    </a>
                    <button
                      className="quiet"
                      onClick={() => {
                        batchRequest.current = "";
                        setBatch(null);
                      }}
                    >
                      创建另一个批次
                    </button>
                  </div>
                )}
                <button
                  className="quiet"
                  onClick={() =>
                    void run(async () => {
                      await api("/admin/logout", "POST");
                      setAdmin(false);
                    })
                  }
                >
                  退出管理端
                </button>
              </>
            )}
          </div>
        </main>
      )}
      <footer>
        <span>灵魂小馆 · 给每一种自己留个位子</span>
        <span>趣味探索 / 不定义你</span>
      </footer>
      {toast && (
        <div role="status" className="toast">
          {toast}
        </div>
      )}
      {poster && (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label="保存结果图片"
        >
          <div className="modal-card">
            <button className="close quiet" onClick={() => setPoster("")}>
              关闭 ×
            </button>
            <h2>你的身份卡，画好了。</h2>
            <p>点击保存，或长按下方图片保存到相册。</p>
            <img src={poster} alt="我的测评结果卡" />
            <button className="primary" onClick={() => void shareImage()}>
              保存 / 分享图片
            </button>
          </div>
        </div>
      )}
      {manualLink && (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label="复制分享链接"
        >
          <div className="modal-card">
            <h2>长按复制这个链接</h2>
            <input
              aria-label="结果分享链接"
              readOnly
              value={manualLink}
              onFocus={(e) => e.target.select()}
            />
            <button className="primary" onClick={() => setManualLink("")}>
              完成
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
