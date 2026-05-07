# Fix Replit Deployment — Quick Reference
## One page. Copy. Share. Done.

---

### THE ONE COMMAND FIX
Paste into Replit AI first:
```
rm -f .git/index.lock
git fetch origin
git reset --hard origin/master
cd artifacts/optima-quant && rm -rf dist && npm install && npm run build
echo "Done — restart workflows"
```

---

### IF git fetch FAILS (no origin remote)
```
python -c "
import os, subprocess
pat = os.environ.get('GH_PASSWORD','')
subprocess.run(['git','remote','remove','origin'], capture_output=True)
subprocess.run(['git','remote','add','origin',
  f'https://USERNAME:{pat}@github.com/USERNAME/REPO.git'])
print('Done' if pat else 'Set GH_PASSWORD secret first')
"
```
Replace USERNAME and REPO with your values.

---

### REQUIRED REPLIT SECRETS
| Secret | Value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_URL` | `https://yourcustomdomain.com` |
| `GH_PASSWORD` | GitHub PAT (ghp_xxx) |
| `GITHUB_TOKEN` | same GitHub PAT |
| `DATABASE_URL` | Postgres connection string |

---

### AUTO-PULL EVERY 5 MINUTES
Add to your Python scheduler:
```python
import subprocess, os

def git_pull_and_rebuild():
    try:
        pat = os.environ.get('GH_PASSWORD','')
        if not pat: return
        result = subprocess.run([
            'git','pull',
            f'https://USERNAME:{pat}@github.com/USERNAME/REPO.git',
            'master'
        ], capture_output=True, text=True,
           cwd='/home/runner/REPO', timeout=30)
        if 'Already up to date' not in result.stdout:
            subprocess.run(['npm','run','build'],
                cwd='/home/runner/REPO/frontend-path',
                timeout=120, capture_output=True)
            print('[Git] Pulled and rebuilt')
    except Exception as e:
        print(f'[Git] Error: {e}')

schedule.every(5).minutes.do(git_pull_and_rebuild)
```

---

### EXPRESS PRODUCTION STATIC SERVING
Add to bottom of server/index.ts (after all routes):
```typescript
import path from 'path'
if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve(__dirname, 
    '../../frontend-path/dist')
  app.use(express.static(dist))
  app.get('*', (req, res) => {
    res.sendFile(path.join(dist, 'index.html'))
  })
}
```

---

### DNS (if custom domain not working)
Add to your domain DNS:
```
Type:  CNAME
Name:  @
Value: your-app.replit.app
TTL:   300
```
Check propagation: whatsmydns.net

---

### VERIFY IT WORKED
```
curl https://yourcustomdomain.com/health
# Should return: {"status":"ok"}

curl https://yourcustomdomain.com/ | grep -i "your app title"
# Should find your app title in HTML
```

---

### COMMON ERRORS
| Error | Fix |
|---|---|
| `no origin remote` | Add GitHub remote (see above) |
| `dist not found` | Run npm run build |
| `site shows old code` | Add auto-pull scheduler |
| `API 404s` | Add Express static serving |
| `db empty on restart` | Set DATABASE_URL secret |
| `domain shows Replit page` | Fix DNS CNAME |
| `env vars missing` | Restart workflows after adding |

---

*Save this file. Paste SKILL.md into /mnt/skills/user/ for Claude to auto-use.*
