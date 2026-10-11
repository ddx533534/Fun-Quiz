import os
import subprocess
import sys
from pathlib import Path
from sqlalchemy import text
from sqlalchemy.orm import Session
from api.main import engine, Code, Attempt
from tests.test_api import client, batch, start, complete


def test_legacy_codes_become_universal_without_resetting_usage_or_reports():
    c=client();_,codes=batch(c,count=1)
    aid=start(c,codes[0],'cat')
    rid=complete(c,aid).json()['result_id']
    before=c.get('/api/results/'+rid).json()['report']
    with Session(engine) as db:
        code=db.get(Code,db.get(Attempt,aid).code)
        code.product='cat';db.commit()
    # Simulate the previous schema, in this isolated test database only.
    with engine.begin() as conn:
        conn.execute(text('ALTER TABLE quiz_attempts DROP COLUMN product'))
    root=Path(__file__).parents[1]
    subprocess.run([sys.executable,'-m','api.migrate'],cwd=root,env=os.environ.copy(),check=True,capture_output=True)
    assert c.get('/api/attempts/'+aid).json()['product']=='cat'
    assert c.get('/api/results/'+rid).json()['report']==before
    grant=c.post('/api/codes/verify',json={'code':codes[0],'product':'next'}).json()
    assert grant['remaining']==2
    next_aid=start(c,codes[0],'next')
    assert complete(c,next_aid).json()['remaining']==1
