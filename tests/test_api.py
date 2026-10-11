import csv
import io
import os
from concurrent.futures import ThreadPoolExecutor

os.environ['APP_ENV'] = 'test'
os.environ['APP_SECRET'] = 'test-secret-not-for-production-' + 'a'*40
os.environ['ADMIN_KEY'] = 'test-admin-key-' + 'b'*40
os.environ['PUBLIC_ORIGIN'] = 'http://testserver'
os.environ['DATABASE_URL'] = os.getenv('TEST_DATABASE_URL', 'sqlite:///./test-api.db')

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, func, event
from api.main import app, engine, Base, Code, Result, Usage, Attempt, decrypt, ADMIN_KEY


def client():
    c = TestClient(app)
    session = c.get('/api/session').json()
    c.headers.update({'Origin':'http://testserver', 'X-CSRF-Token':session['csrf']})
    return c


def batch(c, product='past', count=100, key='test-batch-key-123456'):
    assert c.post('/api/admin/login', json={'key':ADMIN_KEY}).status_code == 200
    response = c.post('/api/admin/batches', json={'product':product,'count':count,'request_key':key})
    assert response.status_code == 200, response.text
    bid = response.json()['id']
    export = c.get('/api/admin/batches/'+bid+'/export')
    assert export.status_code == 200
    rows = list(csv.reader(io.StringIO(export.content.decode('utf-8-sig'))))
    return bid, [row[0] for row in rows[1:]]


def start(c, code, product='past'):
    r = c.post('/api/codes/verify',json={'code':code,'product':product})
    assert r.status_code == 200, r.text
    r = c.post('/api/attempts',json={'grant_id':r.json()['grant_id']})
    assert r.status_code == 200, r.text
    return r.json()['id']


ANSWERS = {f'Q{i:02d}':'D' for i in range(1,25)}


def complete(c, aid, answers=None):
    return c.post('/api/attempts/'+aid+'/complete',json={'answers':answers or ANSWERS})


def counts():
    from sqlalchemy.orm import Session
    with Session(engine) as db:
        return (db.scalar(select(func.sum(Code.used))) or 0,
                db.scalar(select(func.count()).select_from(Result)),
                db.scalar(select(func.count()).select_from(Usage)))


def test_catalog_and_batch_idempotence():
    c=client()
    catalog=c.get('/api/catalog').json()
    assert len(catalog['products'])==4
    assert all(len(p['questions'])==24 for p in catalog['products'])
    bid,codes=batch(c)
    bid2,codes2=batch(c)
    assert bid==bid2 and codes==codes2
    assert len(set(codes))==100 and all(len(code)==19 for code in codes)
    assert counts()==(0,0,0)


def test_three_uses_and_retry():
    c=client();_,codes=batch(c,count=1)
    for expected in (2,1,0):
        aid=start(c,codes[0]);r=complete(c,aid)
        assert r.status_code==200 and r.json()['remaining']==expected
        retry=complete(c,aid)
        assert retry.json()==r.json()
        assert complete(c,aid,{**ANSWERS,'Q01':'A'}).status_code==409
    assert counts()==(3,3,3)
    assert c.post('/api/codes/verify',json={'code':codes[0],'product':'past'}).status_code==409


def test_code_binding_and_ownership():
    c=client();_,codes=batch(c,count=1)
    assert c.post('/api/codes/verify',json={'code':codes[0],'product':'cat'}).status_code==400
    aid=start(c,codes[0]);other=client()
    assert other.get('/api/attempts/'+aid).status_code==404
    assert complete(other,aid).status_code==404
    rid=complete(c,aid).json()['result_id']
    assert other.get('/api/results/'+rid).status_code==404
    assert other.get('/api/admin/batches/x/export').status_code==403


def test_draft_revision_and_no_use_on_failure():
    c=client();_,codes=batch(c,count=1);aid=start(c,codes[0])
    path='/api/attempts/'+aid
    r=c.patch(path,json={'answers':{'Q01':'A'},'revision':0})
    assert r.status_code==200 and r.json()['revision']==1
    assert c.patch(path,json={'answers':{'Q01':'B'},'revision':0}).status_code==409
    assert c.get(path).json()['answers']=={'Q01':'A'}
    assert complete(c,aid,{'Q01':'A'}).status_code==422
    assert counts()==(0,0,0)
    assert c.patch(path,json={'answers':{'Q01':'C'},'revision':1}).status_code==200
    assert counts()==(0,0,0)


def test_shared_snapshot_and_revocation():
    c=client();_,codes=batch(c,count=1);aid=start(c,codes[0]);rid=complete(c,aid).json()['result_id']
    original=c.get('/api/results/'+rid).json()
    token=original['share_url'].split('/')[-1]
    other=client();public=other.get('/api/share/'+token).json()
    assert public['report']['cards']==original['report']['cards']
    assert not set(public['report']) & {'answers','evidence','answer_key','scores','visitor','code','remaining'}
    assert c.delete('/api/results/'+rid+'/share').status_code==200
    assert other.get('/api/share/'+token).status_code==404
    assert c.get('/api/results/'+rid).json()['report']==original['report']
    assert counts()==(1,1,1)


def test_same_answers_same_content():
    c=client();_,codes=batch(c,count=2)
    ids=[complete(c,start(c,code)).json()['result_id'] for code in codes]
    reports=[c.get('/api/results/'+rid).json()['report'] for rid in ids]
    assert reports[0]==reports[1]


def test_csrf_origin():
    c=client()
    assert c.post('/api/admin/login',json={'key':ADMIN_KEY},headers={'Origin':'https://evil.example'}).status_code==403
    assert c.post('/api/admin/login',json={'key':ADMIN_KEY},headers={'X-CSRF-Token':'bad'}).status_code==403


def test_expired_hold_no_use():
    from sqlalchemy.orm import Session
    c=client();_,codes=batch(c,count=1);aid=start(c,codes[0])
    with Session(engine) as db:
        db.get(Attempt,aid).expires=0;db.commit()
    assert complete(c,aid).status_code==410
    assert counts()==(0,0,0)
    assert start(c,codes[0])!=aid


def test_duplicate_submit_concurrent():
    c=client();_,codes=batch(c,count=1);aid=start(c,codes[0])
    with ThreadPoolExecutor(max_workers=10) as pool:
        rows=list(pool.map(lambda _:complete(c,aid),range(10)))
    assert all(r.status_code==200 for r in rows)
    assert len({r.json()['result_id'] for r in rows})==1
    assert counts()==(1,1,1)


def test_hold_concurrency_and_complete():
    c=client();_,codes=batch(c,count=1)
    clients=[client() for _ in range(8)]
    grants=[cc.post('/api/codes/verify',json={'code':codes[0],'product':'past'}).json()['grant_id'] for cc in clients]
    with ThreadPoolExecutor(max_workers=8) as pool:
        rows=list(pool.map(lambda pair:pair[0].post('/api/attempts',json={'grant_id':pair[1]}),zip(clients,grants)))
    assert sum(r.status_code==200 for r in rows)==3
    winners=[(cc,r.json()['id']) for cc,r in zip(clients,rows) if r.status_code==200]
    with ThreadPoolExecutor(max_workers=3) as pool:
        results=list(pool.map(lambda pair:complete(*pair),winners))
    assert all(r.status_code==200 for r in results)
    assert counts()==(3,3,3)


def test_transaction_rolls_back_insert_failure():
    c=client();_,codes=batch(c,count=1);aid=start(c,codes[0])
    def fail_insert(mapper, connection, target):
        raise RuntimeError('injected persistence failure')
    event.listen(Usage,'before_insert',fail_insert)
    try:
        with pytest.raises(RuntimeError,match='injected'):
            complete(c,aid)
    finally:
        event.remove(Usage,'before_insert',fail_insert)
    assert counts()==(0,0,0)
    assert complete(c,aid).status_code==200
    assert counts()==(1,1,1)


def test_failed_logins_are_rate_limited():
    c=client()
    statuses=[c.post('/api/admin/login',json={'key':'invalid'}).status_code for _ in range(6)]
    assert statuses==[403]*5+[429]
