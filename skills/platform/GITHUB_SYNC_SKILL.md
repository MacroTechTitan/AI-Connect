# SKILL: Replit GitHub Sync — Force Update Specific Files

## The Problem
Replit's internal `gitsafe-backup` remote diverges from GitHub.
`git pull` says "0 files to update" even when GitHub has new commits.
The bundle hash stays the same — meaning new code never reaches production.

## Why This Happens
- Replit creates commits to its own internal remote on every Publish
- These commits don't exist on GitHub
- GitHub commits don't exist in Replit
- `compare` endpoint sees them as "in sync" because it compares wrong SHAs

---

## SOLUTION 1 — Force pull a specific file

Use when: You know which file changed and sync says 0 files.

```python
python -c "
import os, requests, base64

pat = os.environ.get('GH_PASSWORD','')
headers = {'Authorization': f'token {pat}'}
repo = 'YOUR_USERNAME/YOUR_REPO'
api = 'https://api.github.com'

# Replace with the file you need to force pull
filepath = 'artifacts/optima-quant/src/pages/login.tsx'

resp = requests.get(
    f'{api}/repos/{repo}/contents/{filepath}',
    headers=headers,
    params={'ref': 'master'}
)
data = resp.json()
content = base64.b64decode(data['content'])

os.makedirs(os.path.dirname(filepath), exist_ok=True)
open(filepath, 'wb').write(content)
print(f'Force pulled: {filepath}')
print(f'Size: {len(content)} bytes')
"
```

---

## SOLUTION 2 — Compare SHAs and force sync all diverged files

Use when: You need to sync everything from GitHub master.

```python
python -c "
import os, requests, base64, subprocess

pat = os.environ.get('GH_PASSWORD','')
headers = {'Authorization': f'token {pat}'}
repo = 'YOUR_USERNAME/YOUR_REPO'
api = 'https://api.github.com'

# Get GitHub master SHA
ref = requests.get(
    f'{api}/repos/{repo}/git/ref/heads/master',
    headers=headers).json()
github_sha = ref['object']['sha']

# Get Replit local SHA
local_sha = subprocess.run(
    ['git','rev-parse','HEAD'],
    capture_output=True, text=True
).stdout.strip()

print(f'GitHub SHA: {github_sha[:8]}')
print(f'Replit SHA: {local_sha[:8]}')

if github_sha == local_sha:
    print('SHAs match but may still be out of sync')
    print('Use Solution 3 for full tree sync')
else:
    # Get all files from GitHub master tree
    tree = requests.get(
        f'{api}/repos/{repo}/git/trees/{github_sha}',
        headers=headers,
        params={'recursive': '1'}
    ).json()
    
    files = [f for f in tree.get('tree', []) 
             if f['type'] == 'blob']
    print(f'Total files on GitHub: {len(files)}')
    
    # Pull key changed files
    key_paths = [
        'artifacts/optima-quant/src/pages/',
        'artifacts/optima-quant/src/components/',
        'artifacts/optima-quant/src/App.tsx',
        'artifacts/api-server/src/',
    ]
    
    pulled = 0
    for f in files:
        if any(f['path'].startswith(p) for p in key_paths):
            resp = requests.get(
                f'{api}/repos/{repo}/contents/{f[\"path\"]}',
                headers=headers,
                params={'ref': 'master'})
            if resp.status_code != 200:
                continue
            data = resp.json()
            if data.get('encoding') != 'base64':
                continue
            content = base64.b64decode(data['content'])
            dirpath = os.path.dirname(f['path'])
            if dirpath:
                os.makedirs(dirpath, exist_ok=True)
            open(f['path'], 'wb').write(content)
            pulled += 1
    
    print(f'Pulled {pulled} files from GitHub')
"
```

---

## SOLUTION 3 — Nuclear option: full tree sync

Use when: Everything is broken and you need a clean slate.

```python
python -c "
import os, requests, base64, subprocess

pat = os.environ.get('GH_PASSWORD','')
headers = {'Authorization': f'token {pat}'}
repo = 'YOUR_USERNAME/YOUR_REPO'
api = 'https://api.github.com'

# Get full tree from GitHub master
ref = requests.get(
    f'{api}/repos/{repo}/git/ref/heads/master',
    headers=headers).json()
sha = ref['object']['sha']

tree = requests.get(
    f'{api}/repos/{repo}/git/trees/{sha}',
    headers=headers,
    params={'recursive': '1'}
).json()

files = [f for f in tree.get('tree',[]) 
         if f['type'] == 'blob']
print(f'Syncing {len(files)} files from GitHub...')

pulled = 0
errors = 0
for f in files:
    # Skip large binary files and node_modules
    if any(x in f['path'] for x in [
        'node_modules', '.git', 'dist/', 
        '.parquet', '.pdf', '.png', '.jpg'
    ]):
        continue
    
    resp = requests.get(
        f'{api}/repos/{repo}/contents/{f[\"path\"]}',
        headers=headers,
        params={'ref': 'master'})
    
    if resp.status_code != 200:
        errors += 1
        continue
        
    data = resp.json()
    if data.get('encoding') != 'base64':
        continue
    
    content = base64.b64decode(data['content'])
    dirpath = os.path.dirname(f['path'])
    if dirpath:
        os.makedirs(dirpath, exist_ok=True)
    
    open(f['path'], 'wb').write(content)
    pulled += 1
    if pulled % 50 == 0:
        print(f'  {pulled} files pulled...')

print(f'Done: {pulled} pulled, {errors} errors')
"
```

---

## SOLUTION 4 — Verify a specific file has latest code

Use when: You want to confirm a file on Replit matches GitHub.

```python
python -c "
import os, requests, base64, hashlib

pat = os.environ.get('GH_PASSWORD','')
headers = {'Authorization': f'token {pat}'}
repo = 'YOUR_USERNAME/YOUR_REPO'
filepath = 'artifacts/optima-quant/src/pages/login.tsx'

# Get GitHub version
resp = requests.get(
    f'https://api.github.com/repos/{repo}/contents/{filepath}',
    headers=headers,
    params={'ref': 'master'})
gh_content = base64.b64decode(resp.json()['content'])
gh_hash = hashlib.md5(gh_content).hexdigest()[:8]

# Get local version
local_content = open(filepath, 'rb').read()
local_hash = hashlib.md5(local_content).hexdigest()[:8]

print(f'GitHub hash: {gh_hash}')
print(f'Local hash:  {local_hash}')
print(f'Match: {gh_hash == local_hash}')

# Show if specific text is in each
search = 'changelog'
print(f'GitHub has \"{search}\": {search in gh_content.decode(errors=\"ignore\")}')
print(f'Local has \"{search}\": {search in local_content.decode(errors=\"ignore\")}')
"
```

---

## After any sync — always rebuild and republish

```bash
# 1. Rebuild
cd artifacts/optima-quant && pnpm run build

# 2. Verify new hash (should be different)
ls -la dist/public/assets/*.js

# 3. Click Republish in Replit UI
echo "Now click Republish in Replit"
```

---

## The full workflow — every time you push to GitHub

```
1. Claude Code pushes to GitHub master
2. In Replit AI paste Solution 1 (specific file) 
   OR Solution 2 (all changed files)
3. Run: cd artifacts/optima-quant && pnpm run build
4. Verify hash changed in build output
5. Click Republish in Replit
6. Test in incognito: yourcustomdomain.com/newpage
```

---

## Common mistakes

| Mistake | Fix |
|---|---|
| Sync says "0 files" but code is old | Use Solution 1 — force pull specific file |
| Hash same after rebuild | File wasn't actually updated — verify with Solution 4 |
| Build fails with npm error | Use `pnpm` not `npm` — Replit workspace requires pnpm |
| Page returns 200 but shows old content | Hard refresh Ctrl+Shift+R or test in incognito |
| `.replit` can't be edited | It's write-protected — configure via Replit UI instead |

---

## For OptimaQuant specifically

Key files to force-pull when things don't update:
```
artifacts/optima-quant/src/pages/login.tsx      (homepage)
artifacts/optima-quant/src/pages/home.tsx        (if exists)
artifacts/optima-quant/src/App.tsx               (routes)
artifacts/optima-quant/src/components/app-sidebar.tsx
artifacts/api-server/src/routes/optima-quant.ts  (API)
```

Repo: `MacroTechTitan/optima-quant`
Build command: `cd artifacts/optima-quant && pnpm run build`
