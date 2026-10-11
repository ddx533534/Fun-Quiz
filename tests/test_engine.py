import itertools
import json
from pathlib import Path
import pytest
from engine.generator import generate, load_library, validate_library, select_candidates, canonical_json


def test_all_96_variants_reachable_and_deterministic():
    lib=load_library();seen=set()
    for product in lib['products']:
        for signs in itertools.product(('A','D'), repeat=3):
            for band in ('low','mid','high'):
                answers={f'Q{i:02d}':signs[(i-1)//6] for i in range(1,19)}
                answers.update({f'Q{i:02d}':('A' if band=='low' else 'D' if band=='high' else 'A' if i%2 else 'D') for i in range(19,25)})
                first=generate(product,answers)
                second=generate(product,dict(reversed(list(answers.items()))))
                assert canonical_json(first)==canonical_json(second)
                assert first['mode']=='single'
                seen.add(first['cards'][0]['variant_id'])
    assert len(seen)==96


def test_balanced_answers_have_eight_equal_identities():
    answers={f'Q{i:02d}':'A' if i%2 else 'D' for i in range(1,25)}
    for product in load_library()['products']:
        report=generate(product,answers)
        assert report['mode']=='equal' and len(report['cards'])==8
        assert all(c['role']=='equal' for c in report['cards'])


def test_abc_boundary_candidates_are_stable():
    lib=load_library()
    for a,b,c in itertools.product(range(-18,19,2),repeat=3):
        mode,codes=select_candidates({'A':a,'B':b,'C':c},lib)
        assert len(codes)==len(set(codes))
        assert all(code in lib['rules']['base_order'] for code in codes)
        if 0 in (a,b,c):
            assert mode=='equal'
            assert len(codes)==2**(sum(v==0 for v in (a,b,c)))


def test_frozen_library_and_question_structure():
    lib=load_library();lib['products']['past']['bases'][0]['quote']+='改动'
    with pytest.raises(ValueError,match='同版本'):
        validate_library(lib)
    questions=json.loads((Path(__file__).parents[1]/'content/questions-v1.json').read_text('utf8'))
    for rows in questions['products'].values():
        assert [q['id'] for q in rows]==[f'Q{i:02d}' for i in range(1,25)]
        assert all(set(o['key'] for o in q['options'])==set('ABCD') for q in rows)
        assert all(q['display_order']==list('ABCD' if i%2 else 'DCBA') for i,q in enumerate(rows,1))
