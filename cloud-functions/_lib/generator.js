import { createHash } from 'node:crypto';
import { library, questions } from './content.js';

export { questions };
export const canonical = value => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
};
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const contentDigest = sha256(canonical(library));
if (library.version !== '1.1.0' || contentDigest !== '37aa1bdbdc1b936ed7414e559022ad182aa661208715cf614b09a332db91cf40') {
  throw new Error('Frozen result library changed without a new version');
}
export const catalog = () => ({ version: questions.version, products: Object.entries(library.products).map(([id, p]) => ({ id, name: p.name, questions: questions.products[id] })) });
export const validProduct = product => Object.hasOwn(library.products, product);
export function validAnswers(answers, complete = false) {
  return answers && typeof answers === 'object' && !Array.isArray(answers) &&
    Object.keys(answers).length <= 24 && (!complete || Object.keys(answers).length === 24) &&
    Object.entries(answers).every(([k, v]) => /^Q(0[1-9]|1\d|2[0-4])$/.test(k) && typeof v === 'string' && /^[ABCD]$/.test(v));
}
export function generate(productKey, answers) {
  if (!validProduct(productKey) || !validAnswers(answers, true)) throw new Error('请完成全部24题，选项仅允许A、B、C、D');
  const product = library.products[productKey], rules = library.rules;
  const scores = Object.fromEntries(Object.entries(rules.axis_question_ranges).map(([axis, [lo, hi]]) => [axis,
    Array.from({ length: hi - lo + 1 }, (_, i) => rules.option_scores[answers['Q' + String(lo + i).padStart(2, '0')]]).reduce((a, b) => a + b, 0)]));
  const abc = ['A', 'B', 'C'].map(a => scores[a]);
  let mode, codes;
  if (abc.includes(0)) {
    mode = 'equal';
    codes = rules.base_order.filter(code => abc.every((v, i) => v === 0 || code[i] === (v > 0 ? '+' : '-')));
  } else {
    const primary = abc.map(v => v > 0 ? '+' : '-').join(''), weak = Math.min(...abc.map(Math.abs));
    const alternatives = new Set();
    if (weak <= rules.near_boundary) abc.forEach((v, i) => {
      if (Math.abs(v) === weak) alternatives.add(primary.slice(0, i) + (primary[i] === '+' ? '-' : '+') + primary.slice(i + 1));
    });
    mode = alternatives.size ? 'near' : 'single';
    codes = [primary, ...rules.base_order.filter(c => alternatives.has(c))];
  }
  const band = scores.D <= rules.suffix_thresholds.low_max ? 'low' : scores.D >= rules.suffix_thresholds.high_min ? 'high' : 'mid';
  const cards = codes.map((code, index) => {
    const base = product.bases.find(b => b.code === code), variant = base.variants[band];
    return { base_id: base.id, variant_id: variant.id, role: mode === 'equal' ? 'equal' : index === 0 ? 'primary' : 'alternative',
      base_name: base.name, variant_name: variant.name, core_text: base.core_text || '', job: base.job,
      daily_scene: base.daily_scene, signature: base.signature, quote: base.quote, gentle_reminder: base.gentle_reminder,
      variant_scene: variant.scene, suffix_text: product.suffixes?.[band] || '' };
  });
  const evidence = Object.fromEntries(Object.entries(rules.axis_question_ranges).map(([axis, [lo, hi]]) => {
    const rows = Array.from({ length: hi - lo + 1 }, (_, j) => {
      const question_id = 'Q' + String(lo + j).padStart(2, '0'), option_key = answers[question_id];
      return { question_id, option_key, score: rules.option_scores[option_key] };
    });
    const strongest = sign => rows.filter(r => r.score * sign > 0).sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.question_id.localeCompare(b.question_id))[0];
    return [axis, scores[axis] === 0 ? [strongest(-1), strongest(1)] : [strongest(Math.sign(scores[axis]))]];
  }));
  const identity = { result_version: library.version, question_version: library.question_version, product: productKey, answers, content_digest: contentDigest };
  return { result_version: library.version, question_version: library.question_version, content_digest: contentDigest,
    answer_key: sha256(canonical(identity)), product: productKey, product_name: product.name, scores, mode,
    headline: mode === 'equal' ? product.equal_title : cards[0].variant_name, band, cards, evidence,
    notice: '文学身份按回答固定匹配；候选顺序是展示顺序，不是概率或优劣排名。' };
}
export const publicReport = report => Object.fromEntries(['result_version', 'question_version', 'product', 'product_name', 'mode', 'headline', 'band', 'cards', 'notice'].map(k => [k, report[k]]));
