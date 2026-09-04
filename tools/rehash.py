#!/usr/bin/env python3
import hashlib, json, os, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
digest = hashlib.sha256(open(os.path.join(root, 'remote.js'), 'rb').read()).hexdigest()

rp = os.path.join(root, 'rules.json')
rules = json.load(open(rp, encoding='utf-8'))
spec = rules.setdefault('remoteScript', {})
old, spec['sha256'] = spec.get('sha256'), digest

if old != digest and '--bump' in sys.argv:
    spec['version'] = int(spec.get('version', 0)) + 1
    rules['rulesVersion'] = int(rules.get('rulesVersion', 0)) + 1

json.dump(rules, open(rp, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('sha256:', digest)
print('изменился:', old != digest, '| remoteScript v%s | rulesVersion %s'
      % (spec.get('version'), rules.get('rulesVersion')))
if old != digest and '--bump' not in sys.argv:
    print('версия не поднята — запусти с --bump, иначе клиенты не увидят обновление')
