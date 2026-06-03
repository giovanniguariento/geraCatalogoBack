# Boreal3D Catálogos — Backend (API)

API REST do Gerador de Catálogos Boreal3DShop.
**Node + Express + PostgreSQL.** Deploy no **Railway**.

As tabelas (`catalogs` e `pages`) são criadas automaticamente no primeiro boot — não há comando de migration para rodar. As imagens dos produtos ficam guardadas no próprio banco (base64).

> Repositório do frontend (React/Vite, deploy na Vercel) é separado.

---

## Rodar localmente

Requer **Node 18+** e um **PostgreSQL**.

```bash
cp .env.example .env     # edite o DATABASE_URL
# Postgres local sem SSL? No .env: DATABASE_SSL=false
npm install
npm run dev              # http://localhost:4000
```

Teste: abra `http://localhost:4000/health` → `{"ok":true}`.

---

## Deploy no Railway

1. https://railway.app → **New Project**.
2. **New → Database → PostgreSQL** (cria o banco e a `DATABASE_URL`).
3. **New → GitHub Repo** apontando para **este** repositório (o `package.json` está na raiz, então não precisa configurar Root Directory).
4. Em **Variables** do serviço:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (referência ao banco)
   - `DATABASE_SSL` = `true`
   - *(opcional)* `API_KEY` = senha secreta longa, para exigir o header `x-api-key`
   - *(opcional)* `FRONTEND_URL` = URL da Vercel, para restringir o CORS
   - `PORT` é injetado pelo Railway — não defina.
5. **Settings → Networking → Generate Domain** → guarde a URL pública
   (ex.: `https://seu-backend.up.railway.app`). É ela que vai no `VITE_API_URL` do frontend.

Comando de start já configurado: `npm start`.

---

## Variáveis de ambiente

| Variável        | Obrigatória | Descrição |
|-----------------|-------------|-----------|
| `DATABASE_URL`  | sim         | Conexão do PostgreSQL |
| `DATABASE_SSL`  | recomendada | `true` em produção; `false` em Postgres local |
| `PORT`          | não         | Injetada pelo Railway |
| `FRONTEND_URL`  | não         | Restringe o CORS a esse domínio |
| `API_KEY`       | não         | Se definida, exige o header `x-api-key` |

---

## Rotas

| Método | Rota | Função |
|--------|------|--------|
| GET    | `/health` | Healthcheck |
| GET    | `/api/catalogs` | Lista catálogos (sem imagens das páginas) |
| POST   | `/api/catalogs` | Cria catálogo |
| GET    | `/api/catalogs/:id` | Catálogo completo com páginas |
| PUT    | `/api/catalogs/:id` | Atualiza nome / configurações (brand) |
| DELETE | `/api/catalogs/:id` | Exclui catálogo |
| POST   | `/api/catalogs/:id/duplicate` | Duplica catálogo |
| POST   | `/api/catalogs/:id/pages` | Adiciona página |
| PUT    | `/api/catalogs/:id/reorder` | Reordena páginas (`{ order: [ids] }`) |
| PUT    | `/api/pages/:id` | Edita página |
| DELETE | `/api/pages/:id` | Exclui página |

---

## Integração com o Bling (opcional)

Totalmente opcional e degradável: sem as credenciais, a busca do Bling fica desativada e o sistema funciona no modo manual normalmente.

**Para ativar:**

1. Crie um aplicativo em https://developer.bling.com.br (escopo de **Produtos – leitura**).
2. Cadastre a **URL de redirecionamento** do app como:
   `https://SEU-BACKEND.up.railway.app/bling/callback`
3. No Railway, defina as variáveis:
   - `BLING_CLIENT_ID`
   - `BLING_CLIENT_SECRET`
   - *(opcional)* `BLING_PRICE_DISCOUNT` (padrão `0.20` = −20%)
4. Faça o redeploy e acesse **uma vez** no navegador:
   `https://SEU-BACKEND.up.railway.app/bling/connect`
   Você loga no Bling, autoriza, e os tokens ficam salvos no banco (sobrevivem a redeploys).

**Endpoints da integração:**
| Método | Rota | Uso |
|--------|------|-----|
| GET | `/bling/connect` | Inicia a autorização (navegador) |
| GET | `/bling/callback` | Retorno do OAuth (navegador) |
| GET | `/api/bling/status` | `{ configured, connected }` |
| GET | `/api/bling/produtos?q=` | Busca produtos por texto |
| GET | `/api/bling/produtos/:id` | Detalhes (preço −20%, descrição, dimensões, peso) |
