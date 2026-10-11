const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

const TYPE_SAFE_URL = "https://api.typesafe.ai/v1/systemone";
const RISK_PATTERN = /(自杀|自残|轻生|急救|诊断|用药|处方|疾病|医疗|手术|怀孕|股票|基金|期货|加密货币|投资|赌博|借贷|贷款|法律|诉讼|合同纠纷|犯罪|违法)/i;

export async function decide(input, { apiKey, fetch: fetcher = fetch }) {
  const mode = input.mode;
  const question = typeof input.question === "string" ? input.question.trim() : "";
  const context = typeof input.context === "string" ? input.context.trim() : "";
  const suppliedOptions = Array.isArray(input.options) ? input.options.map((item) => typeof item === "string" ? item.trim() : "") : [];

  if (mode !== "whether" && mode !== "choice") return json({ status: "error", message: "请选择决策类型。" }, 400);
  if (!question || question.length > 80) return json({ status: "error", message: "问题需要控制在 80 字以内。" }, 400);
  if (!context || context.length > 1200) return json({ status: "error", message: "请提供背景信息，并控制在 1200 字以内。" }, 400);
  if (RISK_PATTERN.test(`${question}\n${context}`)) return json({ status: "error", message: "这个场景风险较高，JEV 不替你做最终决定。请咨询相应专业人士。" }, 422);

  const labels = mode === "whether" ? ["要", "不要"] : suppliedOptions;
  if (labels.length < 2 || labels.length > 4 || labels.some((label) => !label || label.length > 48) || new Set(labels).size !== labels.length) return json({ status: "error", message: "请提供 2–4 个不同的有效选项。" }, 400);

  if (!apiKey) return json({ status: "configuration_error", message: "JEV 服务尚未配置，请稍后再试。" }, 503);

  const criteria = Object.fromEntries(labels.map((label, index) => [`option_${index + 1}`, `Choose this option: ${label}`]));
  const state = {
    user_question: question,
    available_options: labels.map((label, index) => ({ id: `option_${index + 1}`, label })),
    user_context: context,
    task: "Choose exactly one of the available options as the best direct answer to the user's question. Use uncertainty in confidence instead of refusing to choose.",
  };

  const requestBody = JSON.stringify({
    model: "jev-latest",
    state,
    questions: {
      best_option: { type: "choice", instructions: "Which available option is the best direct answer to the user's question? Make the best forced choice from the supplied options. Reflect missing or ambiguous information in confidence rather than refusing to choose. Do not invent or explain facts.", criteria },
    },
  });

  let upstream;
  try {
    upstream = await fetcher(TYPE_SAFE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: requestBody,
      signal: AbortSignal.timeout(60000),
    });
  } catch (cause) {
    console.error("jev_fetch_failed", cause?.name ?? "Error", cause?.message ?? "Unknown fetch error");
    return json({ status: "error", code: "JEV_FETCH_FAILED", message: "暂时无法连接 JEV，请稍后再试。" }, 502);
  }

  if (!upstream.ok) {
    if (upstream.status === 401 || upstream.status === 403) return json({ status: "configuration_error", message: "JEV API Key 无效或没有权限。" }, 503);
    if (upstream.status === 429) return json({ status: "error", message: "JEV 当前请求较多，请稍后再试。" }, 503);
    console.error("jev_upstream_error", upstream.status);
    return json({ status: "error", code: `JEV_UPSTREAM_${upstream.status}`, message: "JEV 暂时不可用，请稍后再试。" }, 502);
  }

  let payload;
  try { payload = await upstream.json(); } catch { return json({ status: "error", message: "JEV 返回了无法识别的结果。" }, 502); }

  const choiceAnswer = payload.answers?.best_option;
  if (!choiceAnswer) return json({ status: "error", message: "JEV 没有返回完整结果。" }, 502);

  const probabilities = choiceAnswer.probabilities ?? {};
  const rawOptions = labels.map((label, index) => { const id = `option_${index + 1}`; return { id, label, probability: clamp(Number(probabilities[id])) || 0 }; });
  const total = rawOptions.reduce((sum, item) => sum + item.probability, 0);
  const resultOptions = rawOptions.map((item) => ({ ...item, probability: total > 0 ? item.probability / total : 0 }));
  const selected = resultOptions.find((item) => item.id === choiceAnswer.choice);
  const confidence = clamp(Number(choiceAnswer.confidence));
  if (!selected || !Number.isFinite(confidence)) return json({ status: "error", message: "JEV 没有返回有效选项。" }, 502);

  const rankedOptions = [...resultOptions].sort((first, second) => second.probability - first.probability);
  const leader = rankedOptions[0];
  const runnerUp = rankedOptions[1];
  const probabilityGap = Math.max(0, leader.probability - runnerUp.probability);
  const strongConfidence = confidence >= 0.7;
  const strongLead = probabilityGap >= 0.15;
  const verdict = strongConfidence && strongLead ? "recommend" : strongConfidence || strongLead ? "lean" : "close";

  return json({
    status: "success",
    selectedOptionId: leader.id,
    selectedOptionLabel: leader.label,
    confidence,
    probabilityGap,
    verdict,
    options: resultOptions,
  });
}

function clamp(value) {
  if (!Number.isFinite(value)) return Number.NaN;
  return Math.min(1, Math.max(0, value));
}
