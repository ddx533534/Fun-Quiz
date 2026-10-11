"""Check active Node Blob build artifacts; actual cloud integration remains separate."""
import json
import subprocess
from pathlib import Path


def test_makers_node_bundle():
    root = Path(__file__).parents[1]
    subprocess.run(['node', 'scripts/build-makers.mjs'], cwd=root, check=True)
    entry = root / 'cloud-functions/api/[[default]].js'
    assert entry.exists()
    assert '@edgeone/pages-blob' in entry.read_text('utf-8')
    assert not (root / 'cloud-functions/api/index.py').exists()
    config = json.loads((root / 'edgeone.json').read_text('utf-8'))
    assert config['buildCommand'] == 'npm run build'
    subprocess.run(['node', '--input-type=module', '-e',
        "import('./cloud-functions/_lib/generator.js').then(m => { if (m.catalog().products.length !== 4) process.exit(1); })"], cwd=root, check=True)
