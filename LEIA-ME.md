# Sol, fase 1: como colocar no ar

São 4 etapas, todas pelo navegador do seu computador Windows. Na primeira vez leva uns 30 minutos.

```
Celular (Chrome)  ──senha──▶  Cloudflare Worker (guarda sua chave)  ──▶  OpenAI
       │                                                                   ▲
       └──────────── voz em tempo real (WebRTC, acesso temporário) ────────┘
```

A sua chave da OpenAI fica **só** no Cloudflare. O celular recebe um acesso que expira em 2 minutos e serve apenas para abrir a conversa.

---

## 1. OpenAI: chave e crédito

1. Entre em **platform.openai.com** com a conta que você criou.
2. **Settings → Billing**: adicione crédito (US$ 10 é suficiente para testar bastante).
3. **Settings → Limits**: defina um limite mensal (ex.: US$ 15). É a sua proteção contra surpresa.
4. **API keys → Create new secret key**: dê o nome `sol`, copie a chave (começa com `sk-`) e guarde por alguns minutos. Ela só aparece uma vez.

## 2. Cloudflare: o servidor intermediário (grátis)

1. Crie uma conta em **dash.cloudflare.com** (plano Free).
2. No menu: **Workers & Pages → Create → Create Worker** (opção "Hello World").
3. Nome: `sol-voz`. Clique em **Deploy**.
4. Clique em **Edit code**, apague tudo, cole o conteúdo do arquivo **`worker.js`** e clique em **Deploy**.
5. Volte ao Worker → **Settings → Variables and Secrets → Add**:

   | Nome | Tipo | Valor |
   |---|---|---|
   | `OPENAI_API_KEY` | Secret | a chave `sk-...` da etapa 1 |
   | `APP_TOKEN` | Secret | uma senha inventada por você (ex.: `sol-felipe-2026-xyz`) |
   | `ALLOWED_ORIGINS` | Text | `https://gagliardi13.github.io` |

6. Copie o endereço do Worker (algo como `https://sol-voz.SEU-USUARIO.workers.dev`).
7. Teste: abra esse endereço no navegador. Deve aparecer `{"ok":true,"servico":"sol"}`.

## 3. GitHub Pages: o site da Sol (grátis)

1. Em **github.com**, clique em **New repository**. Nome: `sol`. Marque **Public**. Crie.
2. Clique em **uploading an existing file** e arraste estes arquivos:
   `index.html`, `app.js`, `avatar.js`, `voice.js`, `persona.js`, `sol.vrm`
   (o `worker.js` e este LEIA-ME não precisam ir, mas não tem problema se forem.)
3. **Commit changes**.
4. **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main` e pasta `/ (root)`. **Save**.
5. Espere 1 a 2 minutos. O site fica em: **https://gagliardi13.github.io/sol/**

## 4. Usar

**Primeiro no PC (recomendado, para validar a voz):**
abra o site no Chrome, preencha os campos, clique em **1. Conectar voz**, permita o microfone e depois **Testar sem AR**. Arraste com o mouse para andar em volta dela e ver ela se virar.

**Depois no Redmi:**
1. Abra o site no **Chrome**.
2. Preencha os campos (ficam salvos no aparelho) → **1. Conectar voz** → permita o microfone.
3. **2. Entrar em realidade aumentada** → permita a câmera.
4. Aponte para o chão e mova o celular devagar. Quando aparecer o anel laranja, toque na tela. A Sol aparece e te cumprimenta.
5. É só conversar. Pode interromper ela a qualquer momento.

Botões na tela: **Mover** (reposiciona ela), **Mudo** (desliga seu microfone), **Legendas**, **Sair**.

> Use fone de ouvido. Sem fone, o microfone pode captar a voz dela e ela "se interromper".

---

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| "Não consegui falar com o servidor" | Endereço do Worker errado ou faltando `https://` |
| "Senha do app incorreta" | Campo de senha diferente do `APP_TOKEN` |
| Erro 403 / "origem não autorizada" | `ALLOWED_ORIGINS` diferente de `https://gagliardi13.github.io` (sem barra no final) |
| "OpenAI recusou" com 401 | Chave da OpenAI errada no Worker |
| "OpenAI recusou" com 429 ou "quota" | Sem crédito na OpenAI |
| "OpenAI recusou" citando o modelo | Crie a variável `MODEL` no Worker com `gpt-realtime-2.1-mini` |
| Ela aparece mas não ouve | Microfone negado: Chrome → cadeado ao lado do endereço → permissões |
| AR não abre | Atualize o Chrome e o "Google Play Services for AR" |
| Travando no celular | Feche outros apps; o modelo 3D tem 10 MB e o Redmi é mais limitado |

## Ajustes

- **Personalidade:** edite `persona.js` no GitHub (lápis ✏️ → Commit). Vale na próxima conexão.
- **Qualidade da voz/inteligência:** no Worker, crie `MODEL` = `gpt-realtime-2.1` (melhor, cerca de 3x mais caro). Sem a variável, usa `gpt-realtime-mini`.
- **Trocar a aparência:** substitua `sol.vrm` por outro modelo VRM (ex.: do VRoid Hub, com licença que permita uso), mantendo o nome `sol.vrm`.

## Créditos

Modelo 3D: amostra oficial da pixiv (VRoid), © 2022 pixiv Inc., licença VRM 1.0 que permite uso, modificação e redistribuição.
Bibliotecas: three.js e @pixiv/three-vrm.
