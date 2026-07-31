# 引き継ぎ: 2台目 n8n環境（Lightsail）の現状 と EC2への移行内容

別エージェント（Claude Code等）に渡すためのまとめ。**現状(2台目Lightsail)の構成**と、**EC2へ移す際の変更点・手順**を記載する。
アプリ層は全てDocker（一部ホストnginx）なので、**EC2化で変わるのは主にインフラ層**。ビルド手順（n8n/Playwright/Chromium）はほぼそのまま流用できる。

---

## 0. 用語・前提
- 対象は「2台目」のn8n環境（1台目 13.159.96.142 とは別）。
- 秘密情報（パスワード/トークン/暗号鍵）は本書に**値を書かない**。サーバの `~/n8n/.env` とnginx設定に存在。移行時に新規発行 or 引き継ぎ。
- リージョン: ap-northeast-1（東京）。AWSアカウント: 347152106712（`ai-optimize-std-dev`）/ CLIプロファイル `ai-optimize`（IAM Identity Center SSO）。

---

## 1. 現状の構成（2台目 Lightsail）

### 1-1. ホスト
| 項目 | 値 |
|---|---|
| 種別 | AWS Lightsail インスタンス |
| 公開IP（静的） | **43.207.98.63**（ユーザー `ubuntu`） |
| OS | Ubuntu 22.04.5 LTS / x86_64 |
| スペック | **2 vCPU / メモリ 1.9GB（+ スワップ2GB）/ ディスク 58GB（使用13GB）** |
| SSH | この開発PCの `~/.ssh/n8n-lightsail.pem`（1台目と共通鍵。authorized_keysに登録済） |
| プロジェクト | `/home/ubuntu/n8n` |

### 1-2. 入口（TLS/リバースプロキシ）※1台目と構成が違う
```
利用者 ─HTTPS→ CloudFront（ドメイン d2q8xprwvide6.cloudfront.net）
      ─→ オリジン: Lightsail 43.207.98.63 の【ホストnginx】
           - listen 80 / 443（443は自己署名証明書 /etc/ssl/n8n/selfsigned.crt）
           - ヘッダ検証: X-Shared-Secret == "MyLightsail2n8nKey2026!" 以外は403（直アクセス遮断）
           - proxy_pass http://localhost:5678/（WebSocket upgrade対応）
      ─→ n8n コンテナ（:5678）
```
- **nginxはコンテナではなくホストにaptで導入**（nginx 1.18.0、`/etc/nginx/sites-enabled/n8n`）。
- 証明書は**自己署名**（Let's Encrypt/certbotは使っていない）。CloudFrontがユーザー向けTLSを担う。
  - ⚠ CloudFrontのオリジン接続（HTTP/HTTPS・ポート・カスタムヘッダ `X-Shared-Secret`）の正確な設定は**CloudFrontディストリビューション設定を確認**して同一に再現すること。
- n8n の公開URL系envは **CloudFrontドメイン**を指す（`WEBHOOK_URL=https://d2q8xprwvide6.cloudfront.net/`, `N8N_HOST`, `N8N_EDITOR_BASE_URL` 同）。

### 1-3. Docker Compose スタック（`/home/ubuntu/n8n/docker-compose.yml`）
- Docker 29.1.3 / **docker-compose v2.24.1（`docker-compose` ハイフンで運用）**
- サービス:
  | サービス | イメージ/ビルド | 役割 |
  |---|---|---|
  | `n8n` | `n8nio/n8n:latest` | ワークフロー。ポート **5678をホストに公開**（0.0.0.0:5678）。前段にホストnginx |
  | `crawler` | `build: ./crawler` | **Playwright + Chromium + p7zip-full**。n8nから `http://crawler:3000` で内部呼び出し |
  | `postgres` | `postgres:16` | n8nのDB |
  | volumes | `n8n_data`, `postgres_data` | 永続データ |
- n8n の主なenv: `N8N_PROTOCOL=https` / `N8N_HOST`,`WEBHOOK_URL`,`N8N_EDITOR_BASE_URL`=CloudFrontドメイン / **`N8N_ENCRYPTION_KEY`（変更厳禁）** / `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` / `CRAWLER_TOKEN`。

### 1-4. crawler（Playwright/Chromium）の作り
- `crawler/Dockerfile`: `FROM mcr.microsoft.com/playwright:v1.49.0-jammy`（**Chromium＋OS依存ライブラリ同梱**）＋ `apt-get install -y p7zip-full`（ZIP解凍）＋ `COPY server.js entrypoint.sh`。
- `crawler/entrypoint.sh`: **Xvfb(:99) を起動してから node**（SMBCの実ブラウザ headful 用。他サイトはheadless）。
- headless起動時オプション: `--no-sandbox --disable-dev-shm-usage`（Docker既定の /dev/shm 64MB対策込み）。
- **実装済みエンドポイント（`crawler/server.js`）**:
  `/health`, `/payoss/{login,meisai,export}`, `/stera/{login,export}`, `/smbc/login`, `/aeon/{login,export}`, `/dpoint/{login,export}`, `/giftcard/{login,export}`。
  - 認証ヘッダ `X-Internal-Token: <CRAWLER_TOKEN>`。認証情報はbody優先→無ければenv。

### 1-5. 対象サイトと方式（重要な差異）
| サイト | 方式 | 備考 |
|---|---|---|
| payoss / stera / aeon / dpoint | AWS(この環境)のheadless Playwrightでフル自動 | ボット対策なし。CSVはpayoss=Shift-JIS, stera=UTF-8(BOM), dpoint=ZIP(PW付き, Shift-JIS名) |
| **giftcard（giftcard.ne.jp）** | headless自動。**IP制限あり→この環境のIP `43.207.98.63` を先方allowlist登録済** | ⚠ **EC2化でegress IPが変わると再度allowlist申請が必要**（下記4-1）。CSV=MS932。`/giftcard/export {month:"YYYYMM"}` で月次ZIP全件→解凍→CSV返却 |
| SMBC | Akamaiでサーバ自動化不可 → **PAD(社内PC)でRPA→n8n WebhookへPOST** | crawlerに`/smbc/login`(headful)はあるが本番非推奨 |
| NEXUS(社内dev) | **社内網限定(10.239.x.x)。AWSからは到達不可** | EC2でもVPN/Direct Connectが無ければ不可 |

### 1-6. n8nワークフロー（`/home/ubuntu/n8n/provision/`）
`payoss-export`, `payoss-meisai`, `stera-export`, `aeon-export`, `dpoint-export`, `giftcard-export`（各 .workflow.json）。n8n UIで Import して使用。

### 1-7. .env のキー（値は伏せる）
`CRAWLER_TOKEN, TZ, PAYOSS_USER/PASS, STERA_USER/PASS, AEON_USER/PASS, DPOINT_USER/PASS/ZIP_PASS, GIFTCARD_COMPANY/USER/PASS`。
（`N8N_ENCRYPTION_KEY` 等はcompose/envに設定。**移行時も同じ値を維持**）

---

## 2. EC2移行後の目標構成
```
利用者 ─HTTPS→ CloudFront（同一ドメイン d2q8xprwvide6.cloudfront.net：変更しない）
      ─→ オリジン: 【EC2のElastic IP】上の nginx（X-Shared-Secret検証）
      ─→ Docker: n8n(:5678) ─ postgres / crawler(Playwright+Chromium)
```
- **アプリ層（Docker Compose + crawler/Playwright/Chromium）はそのまま移設**。ホストにDockerを入れて `docker-compose up -d --build` するだけ。
- **CloudFrontドメインは不変**＝n8nの `WEBHOOK_URL` 等も不変。**変えるのはCloudFrontの“オリジン”を新EIPに向け直すことだけ**。

### 2-1. Lightsail→EC2 で変わる要素（インフラ層）
| 要素 | Lightsail | EC2での対応 |
|---|---|---|
| 固定IP | 静的IP 43.207.98.63 | **Elastic IP** を割当・関連付け（最重要） |
| ストレージ | バンドル58GB | **EBS gp3 30–40GB** |
| ファイアウォール | Lightsail FW | **セキュリティグループ**（22=自IP限定 / 80,443=CloudFront想定） |
| ネットワーク | 隠蔽 | **VPC/サブネット**（既定VPCの公開サブネットで可） |
| メモリ | 1.9GB+swap | **t3.large(8GB) 推奨**、最小 t3.medium(4GB)+2GBスワップ |
| （任意）AWS API権限 | - | S3等使うなら **IAMロール**（インスタンスプロファイル） |

### 2-2. スペック指針
- 推奨: **t3.large（2vCPU/8GB）+ gp3 30GB**。Chromium＋加工に余裕。
- 節約: t3.medium(4GB)+**スワップ2GB**（現状同等）。コスト最優先なら t4g（ARM, Playwrightのarm64タグに変更）。
- 概算(オンデマンド, 東京): t3.medium≈$40/月, t3.large≈$79/月（Lightsail 4GBは≈$20/月なので**約2倍**。要コスト合意）。

---

## 3. 移行手順（リフト&シフト：最小変更）
> `KEY`=SSH秘密鍵, `NEWIP`=新EIP, `OLDIP`=43.207.98.63

1. **EC2作成**: Ubuntu 24.04(または22.04) / t3.large / EBS gp3 30GB / 既定VPC公開サブネット。
2. **Elastic IP** 割当→関連付け（`NEWIP`確定）。
3. **セキュリティグループ**: inbound 22(自IP), 80(0.0.0.0/0 or CloudFront), 443(同)。
4. **Docker導入**: `provision/userdata.sh` を流用（`ssh ... 'sudo bash -s' < provision/userdata.sh`）。
5. **プロジェクト一式を新EC2へ転送**: `~/n8n`（`docker-compose.yml`, `crawler/`, `provision/`）。改行コード正規化 `sed -i 's/\r$//'`。
6. **`.env` を用意**: 旧環境の値を踏襲。**`N8N_ENCRYPTION_KEY` は必ず同一**（変えると既存Credential復号不可）。サイト認証情報も設定。`WEBHOOK_URL`/`N8N_HOST`/`N8N_EDITOR_BASE_URL` は**CloudFrontドメインのまま**（変更不要）。
7. **ホストnginx再現**: `nginx` をapt導入し、`/etc/nginx/sites-enabled/n8n` を同内容で作成（80/443, `X-Shared-Secret`検証, proxy_pass http://localhost:5678/, WebSocket）。自己署名証明書 `/etc/ssl/n8n/selfsigned.*` を作成（`openssl req -x509 ...`）。※ここは「コンテナnginx+Let's Encrypt(1台目方式)」に作り替えてもよい（下記5参照）。
   - `X-Shared-Secret` の値は移行機に**新しい値へローテーション推奨**（旧値 `MyLightsail2n8nKey2026!` は平文で存在するため）。CloudFrontのオリジンカスタムヘッダも同時に更新。
8. **DBデータ移行**（ワークフロー/認証情報を引き継ぐ場合）:
   - 旧: `docker exec n8n-postgres-1 pg_dump -U <PG_USER> <PG_DB> > n8n.sql`
   - 新: 起動後 `cat n8n.sql | docker exec -i <postgres> psql -U <PG_USER> <PG_DB>`
   - `N8N_ENCRYPTION_KEY` が同一なら認証情報も復号可能。
   - （新規作り直しでもよい場合は provision/*.workflow.json を再Importでも可）
9. **起動**: `cd ~/n8n && docker-compose up -d --build`（compose plugin使用なら `docker compose`）。
10. **CloudFrontのオリジン変更**: オリジンのドメイン/IPを `OLDIP`→`NEWIP` に、カスタムヘッダ `X-Shared-Secret` を新値に更新。反映(Deployed)まで数分。
11. **giftcardのIP再申請（重要）**: 先方allowlistを `OLDIP`→`NEWIP` に変更依頼（下記4-1）。
12. **検証**: `https://d2q8xprwvide6.cloudfront.net/` でn8nログイン、各exportワークフロー実行、`/giftcard/export` が新IPで200になること。

---

## 4. 移行時の必須チェック / 落とし穴
### 4-1. ⚠ giftcard の IP allowlist（最重要）
- giftcardは **IP制限**があり、現在 `43.207.98.63` を許可登録している。
- **EC2化でegress IP（EIP）が変わると giftcard は再びブロックされる**。→ **新EIPを先方に再申請**してから giftcardワークフローを使うこと。

### 4-2. N8N_ENCRYPTION_KEY
- **絶対に変更しない**。変えると保存済みCredentialが全て復号不可に。移行前に控える。

### 4-3. Chromium/メモリ
- 1.9GBでは逼迫しがち。EC2は**t3.large推奨**、t3.mediumなら**スワップ2GB**必須。
- 必要なら compose の crawler に `shm_size: "1gb"` を付与（`--disable-dev-shm-usage`併用で通常は不要）。
- `restart: unless-stopped` を各サービスに付けると再起動後自動復帰。

### 4-4. compose コマンド
- 現状 `docker-compose`（ハイフン, v2.24.1）。Docker29はpluginもあるので `docker compose` でも可。どちらか統一。

### 4-5. SMBC / NEXUS
- SMBCは引き続き**社内PCのPAD→n8n Webhook**（EC2化で変わらない）。
- NEXUS(社内dev, 10.239.x.x)はEC2でも**VPN/Direct Connectが無ければ到達不可**。社内網到達が目的なら、VPC＋社内接続の設計が別途必要（本書のスコープ外）。

---

## 5. 任意: 入口をLet's Encrypt方式に作り替える場合（1台目と揃える）
現状の「ホストnginx＋自己署名」を、1台目と同じ「**コンテナnginx＋certbot＋nip.io＋Let's Encrypt**」に統一することも可能。
- 参考: `docs/env-reproduction-handoff.md`（1台目のゼロ構築手順。CloudFront標準ドメイン＋ `<IP>.nip.io` ＋ `X-Origin-Secret`）。
- その場合、ドメイン運用（`DOMAIN=<新EIP>.nip.io`）とCloudFrontオリジン/証明書取得を1台目手順に合わせる。
- リフト&シフト優先なら **現状の自己署名+X-Shared-Secretのまま**移設が最短。

---

## 6. 別エージェントへの依頼文（コピペ例）
> 「AWS EC2(ap-northeast-1, プロファイル ai-optimize)に、既存2台目Lightsail(43.207.98.63)のn8n環境を移行したい。本書 `docs/ec2-migration-handoff.md` の手順3に従い、t3.large + EBS gp3 30GB + Elastic IP + セキュリティグループで構築し、`~/n8n` のDocker Compose(n8n/crawler(Playwright+Chromium)/postgres)とホストnginx(X-Shared-Secret)を再現。`N8N_ENCRYPTION_KEY`は据え置き、postgresは`pg_dump`で移行。CloudFront(d2q8xprwvide6.cloudfront.net)のオリジンを新EIPへ変更。**giftcardのIP allowlistを新EIPへ再申請**するまでgiftcardワークフローは検証保留。サイト認証情報とシークレットは私が`.env`/nginxに設定する。」

---

## 7. 未決事項（依頼側で決める）
1. EC2スペック: t3.large か t3.medium+swap か（コスト許容）。
2. 入口: 現状維持（ホストnginx+自己署名+X-Shared-Secret）か、1台目方式（コンテナnginx+Let's Encrypt+nip.io）に統一するか。
3. データ: 既存ワークフロー/認証情報をpg_dumpで移行するか、新規Import（再設定）か。
4. 社内網(NEXUS)到達をEC2で狙うか（狙うならVPN/DX設計が別途必要）。
