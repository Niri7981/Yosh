"""Materialize exact historical source fixtures outside TypeScript build inputs.
Only source archives/commits are read. No user database or wallet is opened.
"""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

root=Path(__file__).resolve().parents[1]
fixtures=root/'integration/pay-persistence'
manifest=json.loads((fixtures/'compat-sources.json').read_text())
archive=fixtures/manifest['round1Archive']
if hashlib.sha256(archive.read_bytes()).hexdigest()!=manifest['round1ArchiveSha256']:
    raise SystemExit('BLOCKED: Round 1 source archive identity changed')
output=root.parent/'round2-baseline'

def materialize(name,data,mode):
    destination=output/name
    destination.mkdir(parents=True,exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data),mode=mode) as source:
        for member in source.getmembers():
            if not member.isfile() and not member.isdir():
                raise SystemExit('BLOCKED: non-regular compatibility source')
            relative=Path(member.name)
            if relative.is_absolute() or '..' in relative.parts or relative.parts[0]!='src':
                raise SystemExit('BLOCKED: unsafe compatibility member')
            if member.isdir():
                continue
            content=source.extractfile(member).read()
            target=destination/relative
            if target.exists():
                if target.read_bytes()!=content:
                    raise SystemExit(f'BLOCKED: modified compatibility source {name}/{relative}')
            else:
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(content)
    modules=destination/'node_modules'
    if not modules.exists(): modules.symlink_to(root/'node_modules',target_is_directory=True)
    if modules.resolve()!=(root/'node_modules').resolve():
        raise SystemExit('BLOCKED: compatibility dependency identity mismatch')

for name in ['head','pre_owner']:
    content=subprocess.check_output(['git','archive','--format=tar',manifest[name],'src'],cwd=root)
    materialize(name,content,'r:')
materialize('yosh',archive.read_bytes(),'r:gz')
print('Historical/round-start source identities verified; no legacy implementation is rewritten')
