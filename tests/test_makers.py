"""Verify the prefix adapter locally; platform deployment remains an integration check."""
import importlib.util
import subprocess
import sys
from pathlib import Path
from fastapi.testclient import TestClient


def test_makers_asgi_routing():
    root=Path(__file__).parents[1]
    subprocess.run(['node','scripts/build-makers.mjs'],cwd=root,check=True)
    sys.path.insert(0,str(root/'cloud-functions'))
    try:
        spec=importlib.util.spec_from_file_location('makers_entry',root/'cloud-functions/api/index.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        c=TestClient(module.app)
        assert c.get('/health').status_code==200
        catalog=c.get('/catalog').json()
        assert len(catalog['products'])==4
        session=c.get('/session').json()
        c.headers.update({'Origin':'http://testserver','X-CSRF-Token':session['csrf']})
        assert c.post('/admin/login',json={'key':'test-admin-key-'+'b'*40}).status_code==200
    finally:
        sys.path.remove(str(root/'cloud-functions'))
