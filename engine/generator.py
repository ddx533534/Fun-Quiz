"""方案阶段的参考生成器：固定内容库查表，不依赖时钟、用户身份或随机数。"""
from pathlib import Path
import hashlib
import itertools
import json

LIBRARY_PATH = Path(__file__).with_name('测评结果内容库-v1.1.json')
SUPPORTED_VERSION = '1.1.0'
EXPECTED_CONTENT_DIGEST = '37aa1bdbdc1b936ed7414e559022ad182aa661208715cf614b09a332db91cf40'


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def load_library():
    lib = json.loads(LIBRARY_PATH.read_text(encoding='utf-8'))
    validate_library(lib)
    return lib


def validate_library(lib):
    if lib.get('version') != SUPPORTED_VERSION:
        raise ValueError('本参考生成器只支持已冻结的1.1.0结果库。')
    digest = hashlib.sha256(canonical_json(lib).encode('utf-8')).hexdigest()
    if digest != EXPECTED_CONTENT_DIGEST:
        raise ValueError('同版本内容库发生变化；请创建新版本，不得静默改写原结果。')


def normalize_answers(answers):
    keys = [f'Q{i:02d}' for i in range(1, 25)]
    if not isinstance(answers, dict) or set(answers) != set(keys):
        raise ValueError('请提供Q01至Q24全部且仅这24个题目的内容选项键。')
    if any(not isinstance(answers[k], str) or answers[k] not in 'ABCD'
           or len(answers[k]) != 1 for k in keys):
        raise ValueError('选项键仅允许A、B、C、D；不能传入屏幕位置。')
    return {k: answers[k] for k in keys}


def display_orders():
    return {f'Q{i:02d}': list('ABCD' if i % 2 else 'DCBA') for i in range(1, 25)}


def score_axes(answers, library):
    values = library['rules']['option_scores']
    return {axis: sum(values[answers[f'Q{i:02d}']] for i in range(lo, hi + 1))
            for axis, (lo, hi) in library['rules']['axis_question_ranges'].items()}


def select_candidates(scores, library):
    order = library['rules']['base_order']
    abc = [scores[a] for a in 'ABC']
    if 0 in abc:
        choices = [['-', '+'] if v == 0 else ['+' if v > 0 else '-'] for v in abc]
        codes = {''.join(x) for x in itertools.product(*choices)}
        return 'equal', [x for x in order if x in codes]
    primary = ''.join('+' if v > 0 else '-' for v in abc)
    weakest = min(abs(v) for v in abc)
    alternatives = set()
    if weakest <= library['rules']['near_boundary']:
        for i, v in enumerate(abc):
            if abs(v) == weakest:
                candidate = list(primary)
                candidate[i] = '-' if candidate[i] == '+' else '+'
                alternatives.add(''.join(candidate))
    codes = [primary] + [x for x in order if x in alternatives]
    return ('near' if alternatives else 'single'), codes


def evidence_for_axis(axis, answers, scores, library):
    lo, hi = library['rules']['axis_question_ranges'][axis]
    values = library['rules']['option_scores']
    rows = [{'question_id': f'Q{i:02d}', 'option_key': answers[f'Q{i:02d}'],
             'score': values[answers[f'Q{i:02d}']]} for i in range(lo, hi + 1)]
    def strongest(sign):
        relevant = [r for r in rows if r['score'] * sign > 0]
        return sorted(relevant, key=lambda r: (-abs(r['score']), r['question_id']))[0]
    if scores[axis] == 0:
        return [strongest(-1), strongest(1)]
    return [strongest(1 if scores[axis] > 0 else -1)]


def generate(product_key, answers, library=None):
    lib = load_library() if library is None else library
    validate_library(lib)
    if product_key not in lib['products']:
        raise ValueError('未知测评。允许past、next、cat、end。')
    answers = normalize_answers(answers)
    product = lib['products'][product_key]
    scores = score_axes(answers, lib)
    mode, codes = select_candidates(scores, lib)
    threshold = lib['rules']['suffix_thresholds']
    band = ('low' if scores['D'] <= threshold['low_max'] else
            'high' if scores['D'] >= threshold['high_min'] else 'mid')
    by_code = {b['code']: b for b in product['bases']}
    cards = []
    for index, code in enumerate(codes):
        base = by_code[code]
        variant = base['variants'][band]
        cards.append({
            'base_id': base['id'], 'variant_id': variant['id'],
            'role': 'equal' if mode == 'equal' else ('primary' if index == 0 else 'alternative'),
            'base_name': base['name'], 'variant_name': variant['name'],
            'core_text': base.get('core_text', ''), 'job': base['job'],
            'daily_scene': base['daily_scene'], 'signature': base['signature'],
            'quote': base['quote'], 'gentle_reminder': base['gentle_reminder'],
            'variant_scene': variant['scene'],
            'suffix_text': product.get('suffixes', {}).get(band, '')
        })
    content_digest = hashlib.sha256(canonical_json(lib).encode('utf-8')).hexdigest()
    identity = {'result_version': lib['version'], 'question_version': lib['question_version'],
                'product': product_key, 'answers': answers, 'content_digest': content_digest}
    answer_key = hashlib.sha256(canonical_json(identity).encode('utf-8')).hexdigest()
    return {
        'result_version': lib['version'], 'question_version': lib['question_version'],
        'content_digest': content_digest, 'answer_key': answer_key,
        'product': product_key, 'product_name': product['name'], 'scores': scores,
        'mode': mode,
        'headline': product['equal_title'] if mode == 'equal' else cards[0]['variant_name'],
        'band': band, 'cards': cards,
        'evidence': {a: evidence_for_axis(a, answers, scores, lib) for a in 'ABCD'},
        'notice': '文学身份按回答固定匹配；候选顺序是展示顺序，不是概率或优劣排名。'
    }


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--product', choices=['past', 'next', 'cat', 'end'], required=True)
    parser.add_argument('--answers', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = generate(args.product, json.loads(args.answers.read_text(encoding='utf-8')))
    output = canonical_json(result) + '\n'
    if args.output:
        args.output.write_text(output, encoding='utf-8')
    else:
        print(output, end='')
