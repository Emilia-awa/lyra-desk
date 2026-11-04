#!/usr/bin/env bash
# 部署 Lyra Desk 工单侧车。
#
#   bash /root/work/lyra_desk/deploy/install.sh
#
# 幂等：可重复执行。只改 systemd unit 与静态前端两行注入，不碰 Studio 的
# 后端编译产物，也不碰 hermes-web-ui.db。
set -euo pipefail

ROOT=/root/work/lyra_desk
UNIT=/etc/systemd/system/lyra-desk-tickets.service
CLIENT=/root/.hermes/tools/node-26.12.1-linux-x64/lib/node_modules/ekko-studio/dist/client
NODE=/root/.hermes/tools/node-26.12.1-linux-x64/bin/node

echo "== 1/5 目录与权限 =="
mkdir -p "$ROOT/data" "$ROOT/logs" "$ROOT/evidence"
touch "$ROOT/logs/service.log"
chmod 600 "$ROOT/.env"
chmod 700 "$ROOT/data"

echo "== 2/5 语法自检 =="
"$NODE" --check "$ROOT/server/index.mjs"
"$NODE" --check "$ROOT/server/db.mjs"
"$NODE" --check "$ROOT/server/auth.mjs"
"$NODE" --check "$ROOT/server/hermes.mjs"

echo "== 3/5 systemd unit =="
install -m 644 "$ROOT/deploy/lyra-desk-tickets.service" "$UNIT"
systemctl daemon-reload
systemctl enable lyra-desk-tickets
systemctl restart lyra-desk-tickets

echo "== 4/5 前端静态资源 =="
install -m 644 "$ROOT/web/emt-tickets.css" "$CLIENT/assets/css/emt-tickets.css"
install -m 644 "$ROOT/web/emt-tickets.js" "$CLIENT/assets/js/emt-tickets.js"
INDEX="$CLIENT/index.html"
if grep -q 'emt-tickets.css' "$INDEX" && grep -q 'emt-tickets.js' "$INDEX"; then
  echo "index.html 已注入，跳过"
else
  cp -a "$INDEX" "$INDEX.bak_before_tickets"
  python3 - "$INDEX" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
block = ('  <!-- 工单系统（魔改；删掉上面两行即完全恢复） -->\n'
         '  <link rel="stylesheet" href="/assets/css/emt-tickets.css">\n'
         '  <script defer src="/assets/js/emt-tickets.js"></script>\n')
if 'emt-tickets.css' not in s:
    s = s.replace('</head>', block + '</head>', 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('injected into', p)
else:
    print('already present')
PY
fi

echo "== 5/5 健康检查 =="
for i in $(seq 1 20); do
  if curl -fsS --max-time 3 http://127.0.0.1:8653/api/health >/tmp/lyra_desk_health.json 2>/dev/null; then
    cat /tmp/lyra_desk_health.json; echo; break
  fi
  sleep 1
done

echo
echo "完成。常用命令："
echo "  systemctl daemon-reload && systemctl enable --now lyra-desk-tickets"
echo "  systemctl status lyra-desk-tickets"
echo "  tail -f $ROOT/logs/service.log"
echo
echo "nginx（如需从公网 /tickets-api/ 进来，加一条 location；本地 8648 直连不需要）："
echo "  location /tickets-api/ { proxy_pass http://127.0.0.1:8653/api/; proxy_read_timeout 240s; client_max_body_size 8m; }"
